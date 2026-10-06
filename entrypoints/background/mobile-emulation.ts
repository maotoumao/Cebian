// 手机模拟的后台实现：为每个开启的标签页持有一份调试租约并下发 Emulation 覆盖。
//
// 调试连接必须由后台统一持有：侧边栏自己 attach 会和执行脚本的兜底等其它用途抢同一条
// 连接，互相断开（见 lib/browser/debugger-session.ts）。开启状态写进会话级存储
// `mobileEmulatedTabs`，侧边栏据此点亮按钮。

import { acquireDebugger, isDebuggerAvailable, type DebuggerLease } from '@/lib/browser/debugger-session';
import {
  MOBILE_EMULATION_TOGGLE,
  type MobileEmulationToggleRequest,
  type MobileEmulationToggleResponse,
} from '@/lib/browser/mobile-emulation';
import { mobileEmulatedTabs } from '@/lib/persistence/storage';

// iPhone 14 Pro
const DEVICE = {
  width: 393,
  height: 852,
  deviceScaleFactor: 3,
  mobile: true,
  screenWidth: 393,
  screenHeight: 852,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};

const leases = new Map<number, DebuggerLease>();
/** 切换与恢复串行执行，避免同一标签页并发 attach / detach。 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function persist(): Promise<void> {
  await mobileEmulatedTabs.setValue([...leases.keys()]);
}

/** 连接被外部断开（用户取消调试提示条、标签页关闭）：模拟随之失效。 */
function forget(tabId: number): void {
  if (!leases.delete(tabId)) return;
  void persist();
}

async function enable(tabId: number): Promise<void> {
  const lease = await acquireDebugger(tabId, { onDetach: () => forget(tabId) });
  try {
    await lease.send('Emulation.setDeviceMetricsOverride', {
      width: DEVICE.width,
      height: DEVICE.height,
      deviceScaleFactor: DEVICE.deviceScaleFactor,
      mobile: DEVICE.mobile,
      screenWidth: DEVICE.screenWidth,
      screenHeight: DEVICE.screenHeight,
    });
    await lease.send('Emulation.setUserAgentOverride', { userAgent: DEVICE.userAgent });
  } catch (err) {
    await lease.release();
    throw err;
  }
  leases.set(tabId, lease);
  await persist();
}

async function disable(tabId: number): Promise<void> {
  const lease = leases.get(tabId);
  leases.delete(tabId);
  if (lease) {
    try {
      await lease.send('Emulation.clearDeviceMetricsOverride');
      await lease.send('Emulation.setUserAgentOverride', { userAgent: '' });
    } catch {
      // 标签页可能已处于受限状态；照样释放
    }
    await lease.release();
  }
  await persist();
}

/**
 * SW 重启后内存里的租约丢了，但存储里还记着开启的标签页：能接管到本扩展的旧连接，说明
 * 模拟仍然生效，继续持有；接管不到（连接早已断开）就从列表里去掉。
 */
async function restore(): Promise<void> {
  const stored = await mobileEmulatedTabs.getValue();
  if (stored.length === 0) return;
  // 连接早已不在的标签页直接去掉，不必为探测而重新连接（会闪一下调试提示条）
  const attachedTabs = new Set(
    (await chrome.debugger.getTargets()).filter((t) => t.attached && t.tabId != null).map((t) => t.tabId!),
  );
  for (const tabId of stored) {
    if (leases.has(tabId) || !attachedTabs.has(tabId)) continue;
    try {
      const lease = await acquireDebugger(tabId, { onDetach: () => forget(tabId) });
      if (lease.adopted) leases.set(tabId, lease);
      else await lease.release();
    } catch {
      // 标签页已关闭或被其它调试器占用
    }
  }
  await persist();
}

async function toggle(tabId: number): Promise<boolean> {
  if (leases.has(tabId)) {
    await disable(tabId);
    return false;
  }
  await enable(tabId);
  return true;
}

/** 在后台入口调用一次：注册切换请求，并恢复 SW 重启前的状态。 */
function setupMobileEmulation(): void {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== MOBILE_EMULATION_TOGGLE) return false;
    const respond = (response: MobileEmulationToggleResponse) => sendResponse(response);
    const { tabId } = msg as MobileEmulationToggleRequest;
    // 只接受扩展自身页面（侧边栏、以标签页打开的 Cebian）的请求：内容脚本的 sender.url
    // 是所在网页的地址，不能替用户开关模拟
    const fromExtensionPage = sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));
    if (!fromExtensionPage || typeof tabId !== 'number') {
      respond({ ok: false, error: 'Invalid mobile emulation request.' });
      return true;
    }
    if (!isDebuggerAvailable()) {
      respond({ ok: false, error: 'This browser does not support mobile emulation.' });
      return true;
    }
    void serialize(() => toggle(tabId)).then(
      (enabled) => respond({ ok: true, enabled }),
      (err: unknown) => respond({ ok: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  });

  if (isDebuggerAvailable()) {
    void serialize(restore).catch((err) => console.warn('[mobile-emulation] restore failed:', err));
  }
}

// ─── 公开 API ───

export { setupMobileEmulation };
// toggle / restore 仅为同目录单测导出
export { restore, toggle };

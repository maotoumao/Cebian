// 手机模拟的消息契约与界面侧入口：调试连接统一由后台持有（见
// lib/browser/debugger-session.ts），界面（侧边栏 / 以标签页打开的 Cebian）只发切换请求；
// 哪些标签页开着手机模拟由后台写进 `mobileEmulatedTabs` 存储项。

/** 侧边栏 → 后台的一次性切换请求。 */
const MOBILE_EMULATION_TOGGLE = 'cebian:mobile_emulation_toggle';

interface MobileEmulationToggleRequest {
  type: typeof MOBILE_EMULATION_TOGGLE;
  tabId: number;
}

type MobileEmulationToggleResponse = { ok: true; enabled: boolean } | { ok: false; error: string };

/**
 * 当前浏览器能否手机模拟（依赖 debugger API，Firefox 没有）。与 debugger-session 的
 * `isDebuggerAvailable` 判断相同，有意复制一份：界面侧不得引用 debugger-session。
 */
function isMobileEmulationSupported(): boolean {
  return typeof globalThis.chrome?.debugger?.attach === 'function';
}

/** 切换某个标签页的手机模拟，返回切换后是否开启；失败时抛错。 */
async function toggleMobileEmulation(tabId: number): Promise<boolean> {
  const request: MobileEmulationToggleRequest = { type: MOBILE_EMULATION_TOGGLE, tabId };
  const response = (await chrome.runtime.sendMessage(request)) as MobileEmulationToggleResponse | undefined;
  if (!response) throw new Error('No response from the background.');
  if (!response.ok) throw new Error(response.error);
  return response.enabled;
}

// ─── 公开 API ───

export {
  MOBILE_EMULATION_TOGGLE,
  isMobileEmulationSupported,
  toggleMobileEmulation,
  type MobileEmulationToggleRequest,
  type MobileEmulationToggleResponse,
};

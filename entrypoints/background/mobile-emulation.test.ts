import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { mobileEmulatedTabs } from '@/lib/persistence/storage';

type DetachListener = (source: { tabId?: number }, reason: string) => void;

const attached = new Set<number>();
const commands: { tabId: number; method: string }[] = [];
let detachListeners: DetachListener[] = [];

const fakeDebugger = {
  attach: vi.fn(async ({ tabId }: { tabId: number }) => {
    if (attached.has(tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
    attached.add(tabId);
  }),
  detach: vi.fn(async ({ tabId }: { tabId: number }) => {
    attached.delete(tabId);
  }),
  sendCommand: vi.fn(async ({ tabId }: { tabId: number }, method: string) => {
    if (!attached.has(tabId)) throw new Error('not attached');
    commands.push({ tabId, method });
    return {};
  }),
  getTargets: vi.fn(async () => [...attached].map((tabId) => ({ tabId, attached: true }))),
  onEvent: { addListener: () => {} },
  onDetach: { addListener: (fn: DetachListener) => detachListeners.push(fn) },
};

let emulation: typeof import('./mobile-emulation');

beforeEach(async () => {
  vi.clearAllMocks();
  fakeBrowser.reset();
  attached.clear();
  commands.length = 0;
  detachListeners = [];
  vi.stubGlobal('chrome', { ...fakeBrowser, debugger: fakeDebugger });
  vi.resetModules();
  emulation = await import('./mobile-emulation');
});

describe('手机模拟（后台）', () => {
  it('开启时下发覆盖并记进存储，关闭时清除覆盖、断开连接', async () => {
    await expect(emulation.toggle(7)).resolves.toBe(true);
    expect(commands.map((c) => c.method)).toEqual([
      'Emulation.setDeviceMetricsOverride',
      'Emulation.setUserAgentOverride',
    ]);
    expect(await mobileEmulatedTabs.getValue()).toEqual([7]);

    await expect(emulation.toggle(7)).resolves.toBe(false);
    expect(commands.map((c) => c.method).slice(2)).toEqual([
      'Emulation.clearDeviceMetricsOverride',
      'Emulation.setUserAgentOverride',
    ]);
    expect(attached.has(7)).toBe(false);
    expect(await mobileEmulatedTabs.getValue()).toEqual([]);
  });

  it('连接被外部断开（用户取消调试提示条）后从存储里移除', async () => {
    await emulation.toggle(7);
    attached.delete(7);
    detachListeners.forEach((fn) => fn({ tabId: 7 }, 'canceled_by_user'));
    await vi.waitFor(async () => expect(await mobileEmulatedTabs.getValue()).toEqual([]));
  });

  it('SW 重启后：旧连接还在的标签页继续持有，连接已断的从存储里去掉', async () => {
    await mobileEmulatedTabs.setValue([7, 8]);
    attached.add(7); // 7 的连接仍在，8 的早已断开

    await emulation.restore();

    expect(await mobileEmulatedTabs.getValue()).toEqual([7]);
    expect(attached.has(7)).toBe(true);
    // 连接已断的标签页不为探测而重新连接
    expect(fakeDebugger.attach).not.toHaveBeenCalledWith({ tabId: 8 }, expect.anything());
    // 恢复后的 7 能被正常关闭
    await expect(emulation.toggle(7)).resolves.toBe(false);
    expect(attached.has(7)).toBe(false);
  });
});

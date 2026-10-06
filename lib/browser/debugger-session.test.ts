import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

type EventListener = (source: { tabId?: number }, method: string, params?: unknown) => void;
type DetachListener = (source: { tabId?: number }, reason: string) => void;

/** chrome.debugger 的内存假实现：记录 attach 状态，按真实 API 的规则报错。 */
function createFakeDebugger() {
  const attached = new Set<number>();
  const eventListeners: EventListener[] = [];
  const detachListeners: DetachListener[] = [];
  const api = {
    attach: vi.fn(async ({ tabId }: { tabId: number }) => {
      if (attached.has(tabId)) throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
      attached.add(tabId);
    }),
    detach: vi.fn(async ({ tabId }: { tabId: number }) => {
      // 真实的 detach 是异步完成的：断开前的这段时间里再 attach 会报「已被占用」
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!attached.delete(tabId)) throw new Error('Debugger is not attached to the tab with id: ' + tabId);
    }),
    sendCommand: vi.fn(async ({ tabId }: { tabId: number }, method: string): Promise<unknown> => {
      if (!attached.has(tabId)) throw new Error('Debugger is not attached to the tab with id: ' + tabId);
      return { method };
    }),
    onEvent: { addListener: (fn: EventListener) => eventListeners.push(fn) },
    onDetach: { addListener: (fn: DetachListener) => detachListeners.push(fn) },
  };
  return {
    api,
    attached,
    emit: (tabId: number, method: string, params?: unknown) => eventListeners.forEach((fn) => fn({ tabId }, method, params)),
    /** 模拟浏览器从外部断开（用户点提示条「取消」/ 标签页关闭）。 */
    externalDetach: (tabId: number, reason: string) => {
      attached.delete(tabId);
      detachListeners.forEach((fn) => fn({ tabId }, reason));
    },
  };
}

let fake: ReturnType<typeof createFakeDebugger>;
let session: typeof import('./debugger-session');

beforeEach(async () => {
  fake = createFakeDebugger();
  vi.stubGlobal('chrome', { ...fakeBrowser, debugger: fake.api });
  // 模块内有全局会话表与一次性注册的监听，每个用例用新的模块实例
  vi.resetModules();
  session = await import('./debugger-session');
});

describe('acquireDebugger', () => {
  it('同一标签页的多个租约共享一条连接，最后一个释放才断开', async () => {
    const [a, b] = await Promise.all([session.acquireDebugger(1), session.acquireDebugger(1)]);
    expect(fake.api.attach).toHaveBeenCalledTimes(1);

    await a.release();
    expect(fake.attached.has(1)).toBe(true);
    await a.release(); // 幂等
    expect(fake.attached.has(1)).toBe(true);

    await b.release();
    expect(fake.attached.has(1)).toBe(false);
  });

  it('释放后立刻重新租用：等旧连接断完再连，不会接管一条马上断开的连接', async () => {
    const a = await session.acquireDebugger(1);
    const releasing = a.release();
    const b = await session.acquireDebugger(1);
    await releasing;
    expect(b.adopted).toBe(false);
    expect(fake.attached.has(1)).toBe(true);
    await expect(b.send('Page.reload')).resolves.toEqual({ method: 'Page.reload' });
  });

  it('等旧连接断开期间收到外部断开事件：新租约照常建立，不留下无人持有的连接', async () => {
    const a = await session.acquireDebugger(1);
    const releasing = a.release();
    const acquiring = session.acquireDebugger(1);
    // 旧连接还没断完时，用户点了提示条上的「取消」
    fake.externalDetach(1, 'canceled_by_user');
    await releasing;
    const b = await acquiring;
    expect(b.adopted).toBe(false);
    expect(fake.attached.has(1)).toBe(true);
    await b.release();
    expect(fake.attached.has(1)).toBe(false);
  });

  it('attach 失败时所有并发等待者都报错，之后重新租用会再次 attach', async () => {
    fake.api.attach.mockRejectedValueOnce(new Error('Cannot access a chrome:// URL'));
    const results = await Promise.allSettled([session.acquireDebugger(1), session.acquireDebugger(1)]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    const lease = await session.acquireDebugger(1);
    expect(fake.api.attach).toHaveBeenCalledTimes(2);
    expect(lease.adopted).toBe(false);
  });

  it('attach 尚未完成时连接被外部断开：租用报错，且不留下无人持有的连接', async () => {
    let finishAttach!: () => void;
    fake.api.attach.mockImplementationOnce(({ tabId }: { tabId: number }) => new Promise<void>((resolve) => {
      finishAttach = () => { fake.attached.add(tabId); resolve(); };
    }));
    const acquiring = session.acquireDebugger(1);
    await vi.waitFor(() => expect(finishAttach).toBeTypeOf('function'));
    fake.externalDetach(1, 'target_closed');
    finishAttach();
    await expect(acquiring).rejects.toThrow(/detached/);
    await vi.waitFor(() => expect(fake.attached.has(1)).toBe(false));
  });

  it('事件只分发给对应标签页的持有者', async () => {
    const onEvent1 = vi.fn();
    const onEvent2 = vi.fn();
    await session.acquireDebugger(1, { onEvent: onEvent1 });
    await session.acquireDebugger(2, { onEvent: onEvent2 });

    fake.emit(1, 'Network.requestWillBeSent', { requestId: 'r1' });
    expect(onEvent1).toHaveBeenCalledWith('Network.requestWillBeSent', { requestId: 'r1' });
    expect(onEvent2).not.toHaveBeenCalled();
  });

  it('连接被外部断开时带上原因通知所有持有者，之后的命令报错', async () => {
    const onDetachA = vi.fn();
    const onDetachB = vi.fn();
    const a = await session.acquireDebugger(1, { onDetach: onDetachA });
    await session.acquireDebugger(1, { onDetach: onDetachB });

    fake.externalDetach(1, 'canceled_by_user');
    expect(onDetachA).toHaveBeenCalledWith('canceled_by_user');
    expect(onDetachB).toHaveBeenCalledWith('canceled_by_user');
    await expect(a.send('Page.reload')).rejects.toThrow(/detached/);

    // 断开后重新租用会建立新连接
    const c = await session.acquireDebugger(1);
    expect(c.adopted).toBe(false);
    expect(fake.api.attach).toHaveBeenCalledTimes(2);
  });

  it('本扩展的旧连接还在（如 SW 重启后登记丢失）时直接接管', async () => {
    fake.attached.add(1);
    const lease = await session.acquireDebugger(1);
    expect(lease.adopted).toBe(true);
    await lease.release();
    expect(fake.attached.has(1)).toBe(false);
  });

  it('被其它调试器占用（探测命令也失败）时报可读错误，且不留下登记', async () => {
    fake.api.attach.mockRejectedValueOnce(new Error('Another debugger is already attached to the tab with id: 1.'));
    await expect(session.acquireDebugger(1)).rejects.toThrow(/Another debugger/);
    // 登记已清理：下一次租用重新 attach
    const lease = await session.acquireDebugger(1);
    expect(lease.adopted).toBe(false);
  });

  it('浏览器没有 debugger API 时报错', async () => {
    vi.stubGlobal('chrome', { ...fakeBrowser, debugger: undefined });
    expect(session.isDebuggerAvailable()).toBe(false);
    await expect(session.acquireDebugger(1)).rejects.toThrow(/does not support/);
  });
});

describe('executeViaDebugger', () => {
  it('执行完只释放自己的租约，不断开其它持有者的连接', async () => {
    fake.api.sendCommand.mockImplementation(async ({ tabId }: { tabId: number }, method: string) => {
      if (!fake.attached.has(tabId)) throw new Error('not attached');
      return method === 'Runtime.evaluate' ? { result: { value: 'ok' } } : {};
    });
    const emulation = await session.acquireDebugger(1);

    await expect(session.executeViaDebugger(1, 'return "ok"')).resolves.toBe('ok');
    expect(fake.attached.has(1)).toBe(true);
    await expect(emulation.send('Emulation.clearDeviceMetricsOverride')).resolves.toEqual({});
  });
});

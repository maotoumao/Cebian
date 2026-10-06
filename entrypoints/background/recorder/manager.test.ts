import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecorderOptions } from '@/lib/recorder/types';

/** 最小的 chrome.* 假实现：录制器只用到标签页 / 窗口的查询与事件。 */
function makeEvent<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>();
  return {
    addListener: (fn: (...args: T) => void) => listeners.add(fn),
    removeListener: (fn: (...args: T) => void) => listeners.delete(fn),
    emit: (...args: T) => listeners.forEach((fn) => fn(...args)),
  };
}

interface FakeTab { id: number; windowId: number; url: string; active: boolean }

let tabs: FakeTab[];
let tabGetDelay: (tabId: number) => Promise<void>;
let windowGetDelay: (windowId: number) => Promise<void>;
const events = {
  onActivated: makeEvent<[{ tabId: number; windowId: number }]>(),
  onUpdated: makeEvent<[number, chrome.tabs.OnUpdatedInfo, chrome.tabs.Tab]>(),
  onRemoved: makeEvent<[number, { windowId: number; isWindowClosing: boolean }]>(),
  onCreated: makeEvent<[chrome.tabs.Tab]>(),
  onFocusChanged: makeEvent<[number]>(),
};

/** 网络采集的假实现：记下收到的调用。 */
interface FakeCapture {
  observe: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  count: number;
  state: 'active';
}
const captures: FakeCapture[] = [];
vi.mock('./network-capture', () => ({
  startNetworkCapture: () => {
    const capture: FakeCapture = {
      observe: vi.fn(),
      stop: vi.fn(async () => ({ state: 'active', entries: [], filteredCount: 0 })),
      count: 0,
      state: 'active',
    };
    captures.push(capture);
    return { ...capture, tabNavigated: vi.fn(), tabClosed: vi.fn(), observe: capture.observe, stop: capture.stop };
  },
}));

let recorder: typeof import('./manager').recorder;

beforeEach(async () => {
  tabs = [
    { id: 1, windowId: 10, url: 'https://a.test/', active: true },
    { id: 2, windowId: 10, url: 'https://b.test/', active: false },
    { id: 3, windowId: 10, url: 'https://c.test/', active: false },
    { id: 4, windowId: 20, url: 'https://d.test/', active: true },
    { id: 5, windowId: 20, url: 'https://e.test/', active: false },
  ];
  tabGetDelay = async () => {};
  windowGetDelay = async () => {};
  captures.length = 0;
  vi.stubGlobal('chrome', {
    tabs: {
      onActivated: events.onActivated,
      onUpdated: events.onUpdated,
      onRemoved: events.onRemoved,
      onCreated: events.onCreated,
      get: async (tabId: number) => {
        await tabGetDelay(tabId);
        return tabs.find((t) => t.id === tabId);
      },
      query: async ({ windowId }: { windowId: number }) =>
        tabs.filter((t) => t.windowId === windowId && t.active).map((t) => ({ ...t })),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: events.onFocusChanged,
      get: async (windowId: number) => {
        await windowGetDelay(windowId);
        // 返回快照（复制）：之后改动 tabs 不影响已返回的结果
        const type = windowId === 30 ? 'popup' : 'normal';
        return { id: windowId, type, tabs: tabs.filter((t) => t.windowId === windowId).map((t) => ({ ...t })) };
      },
    },
    runtime: { getPlatformInfo: () => {} },
  });
  vi.resetModules();
  ({ recorder } = await import('./manager'));
});

afterEach(async () => {
  // 停掉没收尾的录制：上限检查与保活的定时器不留到下一个用例
  // （个别用例的假拆除永远不结束，最多等一会儿）
  await Promise.race([recorder.stop({ discard: true }), new Promise((resolve) => setTimeout(resolve, 50))]);
});

function hooks() {
  return {
    attach: vi.fn(async () => {}),
    detach: vi.fn(async () => {}),
  };
}

async function start(options?: RecorderOptions, port = {} as chrome.runtime.Port) {
  await recorder.start({ port, instanceId: 'ui', initialWindowId: 10, options });
}

describe('recorder 的录制选项与网络采集', () => {
  it('缺省只录操作：注入内容脚本、收内容脚本事件，不开网络采集', async () => {
    const h = hooks();
    recorder.setAttachHooks(h);
    await start();
    expect(h.attach).toHaveBeenCalledWith(1, expect.any(Number));
    expect(recorder.acceptsContentEvents(1)).toBe(true);
    expect(captures).toHaveLength(0);
    expect(recorder.getStatus().networkState).toBeUndefined();
  });

  it('只录网络：不注入内容脚本、不收操作事件，网络采集跟踪当前标签页，成品带网络记录', async () => {
    const h = hooks();
    recorder.setAttachHooks(h);
    await start({ interactions: false, network: true });
    expect(h.attach).not.toHaveBeenCalled();
    expect(recorder.acceptsContentEvents(1)).toBe(false);
    expect(captures[0].observe).toHaveBeenCalledWith(1, 'https://a.test/');
    expect(recorder.getStatus()).toMatchObject({ networkState: 'active', networkCount: 0 });
    const session = await recorder.stop();
    expect(session?.network).toMatchObject({ state: 'active' });
  });

  it('两项都关不开始录制', async () => {
    const h = hooks();
    recorder.setAttachHooks(h);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await start({ interactions: false, network: false });
    expect(h.attach).not.toHaveBeenCalled();
    expect(captures).toHaveLength(0);
    expect(recorder.getStatus().isRecording).toBe(false);
  });

  it('早于本轮开始的事件（上一轮脚本拆除时排出的残留）不收', async () => {
    recorder.setAttachHooks(hooks());
    await start();
    const startedAt = recorder.getStatus().startedAt!;
    const event = { kind: 'interaction', action: 'click', tabId: 1, url: 'https://a.test/', target: { selector: 'a', tag: 'a' } } as const;
    const before = recorder.getStatus().eventCount;
    recorder.pushEvent(event, startedAt - 1000);
    expect(recorder.getStatus().eventCount).toBe(before);
    recorder.pushEvent(event, startedAt + 10);
    expect(recorder.getStatus().eventCount).toBe(before + 1);
  });

  it('定稿时网络采集立即停止接收，再等内容脚本拆除；成品投递给本轮的发起端口', async () => {
    let finishDetach!: () => void;
    const h = hooks();
    h.detach.mockImplementation(() => new Promise<void>((resolve) => { finishDetach = resolve; }));
    recorder.setAttachHooks(h);
    const port = { name: 'a' } as chrome.runtime.Port;
    const delivered = vi.fn();
    recorder.onRecordingFinished(delivered);
    await start({ interactions: true, network: true }, port);
    const stopping = recorder.stop();
    expect(captures[0].stop).toHaveBeenCalled();
    finishDetach();
    await stopping;
    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ network: expect.anything() }), port);
  });

  it('新一轮等上一轮拆完内容脚本才注入，免得上一轮的拆除把新脚本关掉', async () => {
    let finishDetach!: () => void;
    const order: string[] = [];
    const h = {
      attach: vi.fn(async () => { order.push('attach'); }),
      detach: vi.fn(() => new Promise<void>((resolve) => {
        finishDetach = () => { order.push('detach'); resolve(); };
      })),
    };
    recorder.setAttachHooks(h);
    await start();
    order.length = 0;
    const stopping = recorder.stop({ discard: true });
    const starting = start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([]);
    finishDetach();
    await Promise.all([stopping, starting]);
    expect(order).toEqual(['detach', 'attach']);
  });

  it('同一窗口里连续切换标签页：先发出的查询晚回来也作废，以最后一次切换为准', async () => {
    const h = hooks();
    recorder.setAttachHooks(h);
    await start({ interactions: true, network: true });
    let finishTab2!: () => void;
    tabGetDelay = (tabId) => (tabId === 2 ? new Promise<void>((resolve) => { finishTab2 = resolve; }) : Promise.resolve());
    events.onActivated.emit({ tabId: 2, windowId: 10 });
    events.onActivated.emit({ tabId: 3, windowId: 10 });
    await vi.waitFor(() => expect(recorder.getObservedTabId()).toBe(3));
    finishTab2();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recorder.getObservedTabId()).toBe(3);
    expect(captures[0].observe).toHaveBeenLastCalledWith(3, 'https://c.test/');
    await recorder.stop({ discard: true });
  });

  it('切走后在旧标签页拆完之前又切回来：等拆完再重新注入，不会丢掉操作录制', async () => {
    const live = new Set<number>();
    let finishDetach!: () => void;
    const h = {
      attach: vi.fn(async (tabId: number) => { live.add(tabId); }),
      detach: vi.fn((tabId: number) => new Promise<void>((resolve) => {
        finishDetach = () => { live.delete(tabId); resolve(); };
      })),
    };
    recorder.setAttachHooks(h);
    await start();
    events.onActivated.emit({ tabId: 2, windowId: 10 });
    await vi.waitFor(() => expect(h.detach).toHaveBeenCalledWith(1));
    events.onActivated.emit({ tabId: 1, windowId: 10 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishDetach();
    await vi.waitFor(() => expect(live.has(1)).toBe(true));
    expect(recorder.getObservedTabId()).toBe(1);
    expect(live.has(2)).toBe(false);
  });

  it('切到别的窗口、查询还没返回又切回来：仍录原窗口', async () => {
    recorder.setAttachHooks(hooks());
    await start({ interactions: false, network: true });
    let finishWindow!: () => void;
    windowGetDelay = (windowId) => (windowId === 20 ? new Promise<void>((resolve) => { finishWindow = resolve; }) : Promise.resolve());
    events.onFocusChanged.emit(20);
    await vi.waitFor(() => expect(finishWindow).toBeTypeOf('function'));
    events.onFocusChanged.emit(10);
    finishWindow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recorder.getStatus().activeWindowId).toBe(10);
    expect(captures[0].observe).not.toHaveBeenCalledWith(4, expect.anything());
  });

  it('切到别的窗口、拆旧脚本期间又切回来：按原窗口当前激活的标签页重新接上', async () => {
    const live = new Set<number>();
    let finishDetach!: () => void;
    const h = {
      attach: vi.fn(async (tabId: number) => { live.add(tabId); }),
      detach: vi.fn((tabId: number) => new Promise<void>((resolve) => {
        finishDetach = () => { live.delete(tabId); resolve(); };
      })),
    };
    recorder.setAttachHooks(h);
    await start();
    events.onFocusChanged.emit(20);
    await vi.waitFor(() => expect(h.detach).toHaveBeenCalledWith(1));
    events.onFocusChanged.emit(10);
    finishDetach();
    await vi.waitFor(() => expect(live.has(1)).toBe(true));
    expect(recorder.getStatus().activeWindowId).toBe(10);
    expect(recorder.getObservedTabId()).toBe(1);
  });

  it('同一窗口里切换标签页的途中窗口重新获得焦点（从别的应用点开链接）：不打断这次切换', async () => {
    const live = new Set<number>();
    const h = {
      attach: vi.fn(async (tabId: number) => { live.add(tabId); }),
      detach: vi.fn(async (tabId: number) => { live.delete(tabId); }),
    };
    recorder.setAttachHooks(h);
    await start({ interactions: true, network: true });
    let finishTab2!: () => void;
    tabGetDelay = (tabId) => (tabId === 2 ? new Promise<void>((resolve) => { finishTab2 = resolve; }) : Promise.resolve());
    events.onActivated.emit({ tabId: 2, windowId: 10 });
    await vi.waitFor(() => expect(finishTab2).toBeTypeOf('function'));
    events.onFocusChanged.emit(10);
    finishTab2();
    await vi.waitFor(() => expect(recorder.getObservedTabId()).toBe(2));
    await vi.waitFor(() => expect(live.has(2)).toBe(true));
    expect(captures[0].observe).toHaveBeenLastCalledWith(2, 'https://b.test/');
  });

  it('切到别的窗口、拆旧脚本期间在新窗口换了标签页：跟踪换过去的那个', async () => {
    let finishDetach!: () => void;
    const h = hooks();
    h.detach.mockImplementation(() => new Promise<void>((resolve) => { finishDetach = resolve; }));
    recorder.setAttachHooks(h);
    await start({ interactions: true, network: true });
    events.onFocusChanged.emit(20);
    await vi.waitFor(() => expect(h.detach).toHaveBeenCalledWith(1));
    // 用户在新窗口里选中另一个标签页（此时录制还没切过去，这次激活事件会被忽略）
    tabs.find((t) => t.id === 4)!.active = false;
    tabs.find((t) => t.id === 5)!.active = true;
    events.onActivated.emit({ tabId: 5, windowId: 20 });
    finishDetach();
    await vi.waitFor(() => expect(recorder.getObservedTabId()).toBe(5));
    expect(captures[0].observe).toHaveBeenLastCalledWith(5, 'https://e.test/');
    h.detach.mockImplementation(async () => {});
  });

  it('同一轮里快速 A→B→A→B：第一次切到 B 的注入晚完成，不会拆掉或撤销后一次对 B 的接管', async () => {
    const live = new Set<number>();
    const pendingAttach: Array<() => void> = [];
    let slowFirstB = true;
    const h = {
      attach: vi.fn((tabId: number) => {
        if (tabId === 2 && slowFirstB) {
          slowFirstB = false;
          return new Promise<void>((resolve) => { pendingAttach.push(() => { live.add(2); resolve(); }); });
        }
        live.add(tabId);
        return Promise.resolve();
      }),
      detach: vi.fn(async (tabId: number) => { live.delete(tabId); }),
    };
    recorder.setAttachHooks(h);
    await start();
    events.onActivated.emit({ tabId: 2, windowId: 10 });
    await vi.waitFor(() => expect(pendingAttach).toHaveLength(1));
    events.onActivated.emit({ tabId: 1, windowId: 10 });
    await vi.waitFor(() => expect(recorder.getObservedTabId()).toBe(1));
    events.onActivated.emit({ tabId: 2, windowId: 10 });
    await vi.waitFor(() => expect(recorder.getObservedTabId()).toBe(2));
    await vi.waitFor(() => expect(live.has(2)).toBe(true));
    pendingAttach[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recorder.getObservedTabId()).toBe(2);
    expect(live.has(2)).toBe(true);
  });

  it('跨窗口切换拆旧脚本期间弹出了弹窗：放弃切换并补回原窗口的脚本', async () => {
    const live = new Set<number>();
    let finishDetach!: () => void;
    const h = {
      attach: vi.fn(async (tabId: number) => { live.add(tabId); }),
      detach: vi.fn((tabId: number) => new Promise<void>((resolve) => {
        finishDetach = () => { live.delete(tabId); resolve(); };
      })),
    };
    recorder.setAttachHooks(h);
    await start();
    events.onFocusChanged.emit(20);
    await vi.waitFor(() => expect(h.detach).toHaveBeenCalledWith(1));
    events.onFocusChanged.emit(30);
    finishDetach();
    await vi.waitFor(() => expect(live.has(1)).toBe(true));
    events.onFocusChanged.emit(10);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recorder.getStatus().activeWindowId).toBe(10);
    expect(recorder.getObservedTabId()).toBe(1);
    expect(live.has(1)).toBe(true);
  });

  it('A→B→A→B 快速切换窗口：不重复记录切换、不重复拆装新窗口的脚本', async () => {
    let finishDetach!: () => void;
    let finishWindow!: () => void;
    const h = hooks();
    h.detach.mockImplementationOnce(() => new Promise<void>((resolve) => { finishDetach = resolve; }));
    recorder.setAttachHooks(h);
    await start();
    events.onFocusChanged.emit(20);
    await vi.waitFor(() => expect(finishDetach).toBeTypeOf('function'));
    events.onFocusChanged.emit(10);
    windowGetDelay = (windowId) => (windowId === 20 ? new Promise<void>((resolve) => { finishWindow = resolve; }) : Promise.resolve());
    events.onFocusChanged.emit(20);
    finishDetach();
    await vi.waitFor(() => expect(recorder.getObservedTabId()).toBe(4));
    finishWindow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.attach.mock.calls.filter((call) => (call as unknown[])[0] === 4)).toHaveLength(1);
    expect(recorder.getDebugSnapshot().events.filter((e) => e.kind === 'tab' && e.tabId === 4)).toHaveLength(1);
  });

  it('跨窗口切换拆旧脚本期间旧窗口在后台换了标签页：不取消这次切换', async () => {
    let finishDetach!: () => void;
    const h = hooks();
    h.detach.mockImplementationOnce(() => new Promise<void>((resolve) => { finishDetach = resolve; }));
    recorder.setAttachHooks(h);
    await start({ interactions: true, network: true });
    events.onFocusChanged.emit(20);
    await vi.waitFor(() => expect(finishDetach).toBeTypeOf('function'));
    // 旧窗口当前标签页自己关闭，邻居标签页被激活（窗口并没有获得焦点）
    events.onActivated.emit({ tabId: 2, windowId: 10 });
    finishDetach();
    await vi.waitFor(() => expect(recorder.getStatus().activeWindowId).toBe(20));
    await vi.waitFor(() => expect(recorder.getObservedTabId()).toBe(4));
    expect(captures[0].observe).toHaveBeenLastCalledWith(4, 'https://d.test/');
  });
});

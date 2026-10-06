// 本扩展对 chrome.debugger 的唯一出入口：按标签页引用计数共享一个调试会话。
//
// chrome.debugger 的连接按「扩展」计：同一扩展对同一标签页只能 attach 一次，任何一处
// detach 都会把整条连接断掉。执行脚本的兜底路径、手机模拟（以及之后的网络录制）都要连
// 调试器，各自 attach / detach 会互相断开对方，所以统一在这里租用：首个租约 attach，
// 最后一个释放才 detach。
//
// 只在后台使用（依赖 chrome.debugger 的全局事件，必须由唯一的上下文持有连接）；
// 侧边栏 / 组件不得引用本文件（.dependency-cruiser.cjs 有规则守着）。

type DebuggerEventHandler = (method: string, params: unknown) => void;
/** `reason`：`canceled_by_user`（用户点了调试提示条上的「取消」）或 `target_closed`。 */
type DebuggerDetachHandler = (reason: string) => void;

interface DebuggerLeaseHandlers {
  onEvent?: DebuggerEventHandler;
  /** 连接被外部断开时调用（之后租约失效，不必再 release）。主动 release 不会触发。 */
  onDetach?: DebuggerDetachHandler;
}

interface DebuggerLease {
  readonly tabId: number;
  /**
   * attach 时发现本扩展的旧连接还在（如 SW 重启后内存里的登记丢了）而直接接管，
   * 而不是新建连接。持有者可据此判断此前在该连接上做的设置（如手机模拟）是否仍然生效。
   */
  readonly adopted: boolean;
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** 幂等。最后一个持有者释放时断开连接。 */
  release(): Promise<void>;
}

interface Holder extends DebuggerLeaseHandlers {
  active: boolean;
}

interface TabSession {
  /** attach 完成后 resolve 为是否接管了旧连接；失败则 reject。 */
  ready: Promise<boolean>;
  holders: Set<Holder>;
}

const PROTOCOL_VERSION = '1.3';

const sessions = new Map<number, TabSession>();
/** 正在断开的连接：新的 attach 必须等它断完，否则会接管一条马上要断的连接。 */
const detaching = new Map<number, Promise<void>>();
let listenersInstalled = false;

function isDebuggerAvailable(): boolean {
  return typeof globalThis.chrome?.debugger?.attach === 'function';
}

function installListeners(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId == null) return;
    const session = sessions.get(source.tabId);
    if (!session) return;
    for (const holder of session.holders) {
      if (holder.active) holder.onEvent?.(method, params);
    }
  });
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId == null) return;
    const session = sessions.get(source.tabId);
    if (!session) return;
    sessions.delete(source.tabId);
    for (const holder of session.holders) {
      if (!holder.active) continue;
      holder.active = false;
      holder.onDetach?.(reason);
    }
  });
}

/**
 * 连接标签页，返回是否接管了本扩展的旧连接。已被占用时，用一条只读、不依赖页面执行
 * 上下文的命令探测：能执行说明连接是本扩展自己的（如 SW 重启后登记丢了），直接接管；
 * 不能执行说明是别的调试器（如其它扩展）占着。
 */
async function attach(tabId: number): Promise<boolean> {
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    return false;
  } catch (err) {
    if (!/already attached/i.test(String((err as Error)?.message))) throw err;
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree');
      return true;
    } catch {
      throw new Error('Another debugger (for example another extension) is already attached to this tab.');
    }
  }
}

function detach(tabId: number): void {
  // 标签页已关闭或连接已断时 detach 会失败，忽略即可
  const done = chrome.debugger
    .detach({ tabId })
    .catch(() => undefined)
    .finally(() => {
      if (detaching.get(tabId) === done) detaching.delete(tabId);
    });
  detaching.set(tabId, done);
}

/**
 * 租用某个标签页的调试连接。同一标签页的所有租约共享一条连接；attach 失败时抛错。
 */
async function acquireDebugger(tabId: number, handlers: DebuggerLeaseHandlers = {}): Promise<DebuggerLease> {
  if (!isDebuggerAvailable()) throw new Error('This browser does not support the debugger API.');
  installListeners();

  // 旧连接正在断开时先等它断完，再登记新会话：否则等待期间到来的外部断开事件会落到
  // 新会话头上，而随后的 attach 又建起一条无人持有的连接。
  for (let pending = detaching.get(tabId); pending; pending = detaching.get(tabId)) {
    await pending;
  }

  let session = sessions.get(tabId);
  if (!session) {
    session = { ready: attach(tabId), holders: new Set() };
    sessions.set(tabId, session);
  }
  // 先登记再等 attach：并发的 release 看到还有持有者，就不会把连接断掉
  const holder: Holder = { ...handlers, active: true };
  session.holders.add(holder);

  let adopted: boolean;
  try {
    adopted = await session.ready;
  } catch (err) {
    session.holders.delete(holder);
    if (sessions.get(tabId) === session) sessions.delete(tabId);
    throw err;
  }
  // attach 期间连接已被外部断开（onDetach 已把 holder 置为失效）
  if (!holder.active) {
    // 会话已被注销而 attach 却成功了：这条连接没有任何持有者，断开它（真被断开时 detach 无害失败）
    if (!sessions.has(tabId)) detach(tabId);
    throw new Error('The debugger was detached from this tab.');
  }

  const owner = session;
  return {
    tabId,
    adopted,
    async send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
      if (!holder.active) throw new Error('The debugger was detached from this tab.');
      return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
    },
    async release(): Promise<void> {
      if (!holder.active) return;
      holder.active = false;
      owner.holders.delete(holder);
      if (owner.holders.size > 0 || sessions.get(tabId) !== owner) return;
      sessions.delete(tabId);
      detach(tabId);
      await detaching.get(tabId);
    },
  };
}

/**
 * 经 CDP `Runtime.evaluate` 在页面里执行代码。页面 CSP 拦住 `new Function` / eval 时的兜底，
 * 或需要直接走 CDP 时使用。只租用连接，不会断开其它功能（如手机模拟）持有的连接。
 */
async function executeViaDebugger(tabId: number, code: string): Promise<string> {
  const lease = await acquireDebugger(tabId);
  try {
    const expression = `(async () => { ${code} })()`;
    const result = await lease.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });

    if (result.exceptionDetails) {
      const errMsg = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'Unknown error';
      return `Error: ${errMsg}`;
    }

    const value = result.result?.value;
    if (value === undefined) return '(no return value)';
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } finally {
    await lease.release();
  }
}

// ─── 公开 API ───

export {
  acquireDebugger,
  executeViaDebugger,
  isDebuggerAvailable,
  type DebuggerLease,
  type DebuggerLeaseHandlers,
};

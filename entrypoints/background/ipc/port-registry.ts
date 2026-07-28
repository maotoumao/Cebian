// UI 实例 ↔ background 的端口注册表：连接表 + 投递 + 连接生命周期事件源。
//
// **纯传输层**：只认识「一条连接」和「它订阅了哪个频道」，不认识 session / recorder /
// memory / MCP 任何一个业务域。域相关的行为（首帧状态同步、断连时取消 agent、断连时
// 丢弃录制、消息路由）由各域通过 `onPortConnect` / `onPortDisconnect` 自行接入。
//
// 因此这里**不得** import 任何能力目录（chat / recorder / memory / page-actions）——
// 反向依赖会把业务耦合重新塞回传输层。
//
// 只管 `CLIENT_PORT` 这一条长连接。划词动作另有自己的一次性流式端口（PAGE_ACTION_PORT），
// 由 lib/page-actions/manager.ts 独立处理，不进本表。

import { CLIENT_PORT, type ServerMessage } from '@/lib/ipc/protocol';

/** 一条连接的传输层状态。 */
interface PortState {
  /**
   * 该端口订阅的广播频道；null = 未订阅。传输层不认识这个字符串的语义——今天由 chat
   * 层填入 sessionId。
   */
  subscription: string | null;
  /** 对端 UI 实例 id（由 `hello` 消息声明）。用于区分同一浏览器里的多个侧边栏实例。 */
  instanceId: string | null;
}

type ConnectListener = (port: chrome.runtime.Port) => void;
type DisconnectListener = (port: chrome.runtime.Port, last: Readonly<PortState>) => void;

/** 所有已连接的端口及其状态。模块级状态，生命周期 = service worker 生命周期。 */
const ports = new Map<chrome.runtime.Port, PortState>();

const connectListeners = new Set<ConnectListener>();
const disconnectListeners = new Set<DisconnectListener>();

// ─── 投递 ───

/**
 * 向单个端口投递，吞掉「端口已断开」的异常。
 *
 * 对端关闭后（侧边栏被关、标签页跳走、对端 SW 被挂起）Chrome 会在 `postMessage` 时
 * 抛错。对状态推送与 RPC 回复而言，正确行为是「尽力而为、不升级为错误」。所有
 * **尽力而为的**投递都走这里，避免各处 `try/catch` 各自漂移。
 *
 * 例外：录制成品的投递（`recorder_session`）故意不走这里——丢掉一份已完成的录制
 * 值得打一条 warn，而不是静默吞掉。
 */
function post(port: chrome.runtime.Port, msg: ServerMessage): void {
  try {
    port.postMessage(msg);
  } catch {
    /* 对端已断开 */
  }
}

/** 投给所有订阅了 `subscription` 频道的端口。 */
function broadcast(subscription: string, msg: ServerMessage): void {
  for (const [port, state] of ports) {
    if (state.subscription === subscription) post(port, msg);
  }
}

/** 投给所有已连接的端口（非频道限定的全局消息）。 */
function broadcastAll(msg: ServerMessage): void {
  for (const port of ports.keys()) post(port, msg);
}

// ─── 查询与变更 ───

/** 取某端口状态的只读视图（指向表里的活对象，非快照；`Readonly` 仅阻止经此引用
 *  修改）。未登记（已断开 / 非本表端口）返回 undefined。 */
function getPortState(port: chrome.runtime.Port): Readonly<PortState> | undefined {
  return ports.get(port);
}

/** 是否还有端口订阅着 `subscription`。断连回调里调用时，刚断开的那条已经出表。 */
function hasSubscriber(subscription: string): boolean {
  for (const state of ports.values()) {
    if (state.subscription === subscription) return true;
  }
  return false;
}

/** 改变某端口的订阅频道。状态只经 setter 变更，`grep setSubscription` 即可列出所有
 *  改变路由的地方——路由错乱是最难查的一类 bug，值得这点显式。 */
function setSubscription(port: chrome.runtime.Port, subscription: string | null): void {
  const state = ports.get(port);
  if (state) state.subscription = subscription;
}

/** 记下对端声明的 UI 实例 id。 */
function setInstanceId(port: chrome.runtime.Port, instanceId: string): void {
  const state = ports.get(port);
  if (state) state.instanceId = instanceId;
}

// ─── 连接生命周期 ───

/** 订阅「新端口已登记」。回调里可发域首帧、接路由。返回取消订阅函数。 */
function onPortConnect(listener: ConnectListener): () => void {
  connectListeners.add(listener);
  return () => connectListeners.delete(listener);
}

/** 订阅「端口已断开」。回调收到断开前的状态快照（此时登记项已出表，故
 *  `hasSubscriber` 天然不含它）。返回取消订阅函数。 */
function onPortDisconnect(listener: DisconnectListener): () => void {
  disconnectListeners.add(listener);
  return () => disconnectListeners.delete(listener);
}

/**
 * 注册 `chrome.runtime.onConnect`，开始受理连接。
 *
 * **在所有 `onPortConnect` / `onPortDisconnect` 订阅者注册完之后调用**（`index.ts` 的
 * 启动序列最后一步）：先开订阅、再开门，杜绝早到的连接漏掉域首帧。
 */
function setupPortRegistry(): void {
  chrome.runtime.onConnect.addListener((port) => {
    // 只受理 UI 实例的长连接；其它端口（划词流式）由各自的 handler 处理。
    if (port.name !== CLIENT_PORT) return;

    ports.set(port, { subscription: null, instanceId: null });
    // 传输层握手：告诉对端「已登记」。域相关的首帧由订阅者各自发送。
    post(port, { type: 'connected' });

    for (const listener of connectListeners) listener(port);

    port.onDisconnect.addListener(() => {
      // 先抓快照再出表：订阅者需要知道它断开前订阅的是哪个频道，而此时登记项已删，
      // 使订阅者在回调里调 `hasSubscriber` 时自然不会数到刚断的这条。
      const last = ports.get(port) ?? { subscription: null, instanceId: null };
      ports.delete(port);
      for (const listener of disconnectListeners) listener(port, last);
    });
  });
}

// ─── 公开 API ───

export {
  setupPortRegistry,
  onPortConnect,
  onPortDisconnect,
  post,
  broadcast,
  broadcastAll,
  getPortState,
  hasSubscriber,
  setSubscription,
  setInstanceId,
};

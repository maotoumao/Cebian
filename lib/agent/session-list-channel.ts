// UX 侧的会话列表通道（拉列表 / 删除 / 改位置 / 改名）。
//
// 端口由 `useBackgroundAgent` 持有——历史面板不另开端口，遵循 lib/ipc/protocol.ts
// 顶部「一个 UI 实例只开一条端口，其它域走 channel shim 复用它」的约定。形状与
// lib/recorder/sidepanel-channel.ts、lib/mcp/sidepanel-channel.ts 一致。
//
// 在此之前 HistoryPanel 每做一件事就自己 connect 一条一次性端口再断开（拉列表一条、
// 每次删除又一条），请求 / 响应的配对逻辑散在各个回调里。

import type { SessionPlacement } from '@/lib/persistence/db';
import type { ClientMessage, SessionMeta, SessionWriteOp } from '@/lib/ipc/protocol';

type ListListener = (sessions: SessionMeta[]) => void;
type DeletedListener = (sessionIds: string[]) => void;
type WriteFailedListener = (op: SessionWriteOp, sessionIds: string[], message: string) => void;
type PlacementListener = (sessionIds: string[], placement: SessionPlacement) => void;
type RenamedListener = (sessionId: string, title: string) => void;
type ErrorListener = (message: string) => void;

const listListeners = new Set<ListListener>();
const deletedListeners = new Set<DeletedListener>();
const writeFailedListeners = new Set<WriteFailedListener>();
const placementListeners = new Set<PlacementListener>();
const renamedListeners = new Set<RenamedListener>();
const errorListeners = new Set<ErrorListener>();

/** Active port. Set by `useBackgroundAgent` on connect/disconnect. */
let portRef: chrome.runtime.Port | null = null;

/**
 * 往端口投一条消息。端口可能正在死去（SW 被回收），`postMessage` 会抛——一律接住并
 * 返回 false：`subscribeList` 里它先于 return 执行，抛出去就会让调用方拿不到退订函数、
 * 把监听器永久留在模块级 Set 里；`delete` 的布尔契约也不该被异常绕过。
 */
function post(msg: ClientMessage): boolean {
  if (!portRef) return false;
  try {
    portRef.postMessage(msg);
    return true;
  } catch (err) {
    console.warn('[sessionListChannel] postMessage failed:', err);
    portRef = null;
    return false;
  }
}

/**
 * 是否已有一次拉取在途。同一时刻只允许一条 `session_list` 在飞：响应里没有请求 id，
 * 后台的 handler 又是各自独立的 async 调用，两条并发请求谁的库读先落定谁就先回——
 * 晚到的那条旧快照会把新快照整个盖掉，而且此后没有任何请求会来纠正它，面板就一直
 * 停在旧数据上。串行化直接消掉这一整类问题，代价只是「已经在拉了就不重复拉」。
 *
 * 卡死风险：请求既不回结果也不报错的唯一途径是端口死掉（SW 被回收），而那必然触发
 * onDisconnect → setPort(null)，下面会把标志清掉。
 */
let listInFlight = false;

function requestList(): void {
  if (listInFlight) return;
  listInFlight = post({ type: 'session_list' } satisfies ClientMessage);
}

export const sessionListChannel = {
  setPort(p: chrome.runtime.Port | null): void {
    portRef = p;
    // 换端口（含断开）：旧端口上的在途请求永远不会回来了，清掉标志。
    listInFlight = false;
    // 重连后（SW 被回收再起来）自动补一次拉取，订阅方不必自己盯连接状态。
    if (p && listListeners.size > 0) requestList();
  },

  /** 后台回了一份列表——扇出给订阅方。单个订阅方抛错不牵连兄弟（同 recorderChannel）。 */
  publishList(sessions: SessionMeta[]): void {
    listInFlight = false;
    for (const l of listListeners) {
      try { l(sessions); } catch (err) { console.warn('[sessionListChannel] list listener threw:', err); }
    }
  },

  /** 这批会话已被删除。后台是广播给所有端口的，因此别的窗口删的也会到这里。 */
  publishDeleted(sessionIds: string[]): void {
    for (const l of deletedListeners) {
      try { l(sessionIds); } catch (err) { console.warn('[sessionListChannel] deleted listener threw:', err); }
    }
  },

  /** 这批会话的写操作没成功。只发给发起方，用于撤销它的乐观更新。 */
  publishWriteFailed(op: SessionWriteOp, sessionIds: string[], message: string): void {
    for (const l of writeFailedListeners) {
      try { l(op, sessionIds, message); } catch (err) { console.warn('[sessionListChannel] writeFailed listener threw:', err); }
    }
  },

  /** 某批会话的列表位置变了。同 `publishDeleted`，别的窗口改的也会到这里。 */
  publishPlacement(sessionIds: string[], placement: SessionPlacement): void {
    for (const l of placementListeners) {
      try { l(sessionIds, placement); } catch (err) { console.warn('[sessionListChannel] placement listener threw:', err); }
    }
  },

  /** 某个会话改了标题（用户改名或自动生成）。同 `publishPlacement`，别的窗口改的也会到这里。 */
  publishRenamed(sessionId: string, title: string): void {
    for (const l of renamedListeners) {
      try { l(sessionId, title); } catch (err) { console.warn('[sessionListChannel] renamed listener threw:', err); }
    }
  },

  /** 后台处理列表请求时出错了。订阅方据此立刻收掉 loading，不必干等超时。 */
  publishError(message: string): void {
    listInFlight = false;
    for (const l of errorListeners) {
      try { l(message); } catch (err) { console.warn('[sessionListChannel] error listener threw:', err); }
    }
  },

  /** 订阅列表结果。订阅当下若已连上就立刻请求一次（已有在途请求则复用它），省得
   *  调用方再手动触发。 */
  subscribeList(l: ListListener): () => void {
    listListeners.add(l);
    requestList();
    return () => { listListeners.delete(l); };
  },

  subscribeDeleted(l: DeletedListener): () => void {
    deletedListeners.add(l);
    return () => { deletedListeners.delete(l); };
  },

  subscribeWriteFailed(l: WriteFailedListener): () => void {
    writeFailedListeners.add(l);
    return () => { writeFailedListeners.delete(l); };
  },

  subscribePlacement(l: PlacementListener): () => void {
    placementListeners.add(l);
    return () => { placementListeners.delete(l); };
  },

  subscribeRenamed(l: RenamedListener): () => void {
    renamedListeners.add(l);
    return () => { renamedListeners.delete(l); };
  },

  subscribeError(l: ErrorListener): () => void {
    errorListeners.add(l);
    return () => { errorListeners.delete(l); };
  },

  /** 重新拉一次列表。用于「本地状态可能已经不对了」的场景（如删除失败后回滚）。 */
  refresh(): void {
    requestList();
  },

  /** 删除一批会话。Returns true if the message was posted; false if no port is connected. */
  delete(sessionIds: string[]): boolean {
    return post({ type: 'session_delete', sessionIds } satisfies ClientMessage);
  },

  /** 设置一批会话的列表位置。Returns true if the message was posted. */
  setPlacement(sessionIds: string[], placement: SessionPlacement): boolean {
    return post({ type: 'session_set_placement', sessionIds, placement } satisfies ClientMessage);
  },

  /** 改一个会话的标题（已在 UI 侧 trim；后台再归一化）。Returns true if the message was posted. */
  rename(sessionId: string, title: string): boolean {
    return post({ type: 'session_rename', sessionId, title } satisfies ClientMessage);
  },
};

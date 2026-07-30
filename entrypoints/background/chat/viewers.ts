// chat 域的会话路由：哪个 UI 窗口正在看哪个会话。
//
// 这是 **chat 的业务状态**，不是传输概念 —— `ipc/port-registry.ts` 只认识「一条连接」，
// 不该存一个它不理解的 sessionId。两个问题都由这张表回答：
//   - 广播该发给谁（只发给正在显示这个会话的窗口，避免每条 `message_update` 乘以窗口数）
//   - 最后一个窗口走了没有（没人看着 → agent 吐的字没有落脚处）
//
// 本模块只放状态与投递，**不 import `session-manager`** —— 否则
// session-manager → viewers → session-manager 成运行时环，depcruise 会红。因此
// 「最后一个 viewer 断连后 grace-cancel」这条策略住在编排侧（今天的 `index.ts`），
// 由它调 `stopViewing(port)` 拿到该窗口原本在看的会话再决定。注意只有**断连**会触发
// grace-cancel；`unsubscribe` 消息同样调 `stopViewing`，但忽略返回值（用户还在，只是
// 换了页面）。

import type { ServerMessage } from '@/lib/ipc/protocol';
import { post } from '../ipc/port-registry';

/** port → 它当前正在看的 sessionId。模块级状态，生命周期 = service worker 生命周期 */
const viewers = new Map<chrome.runtime.Port, string>();

/**
 * 记下某窗口正在看的会话。`subscribe` / `prompt` / `retry` 都会调 —— 后两者是因为
 * 「发起一轮对话」本身就意味着这个窗口正在看它
 */
function setViewing(port: chrome.runtime.Port, sessionId: string): void {
  viewers.set(port, sessionId);
}

/**
 * 该窗口不再看任何会话（`unsubscribe` / 断连）。
 *
 * 返回它此前在看的会话（没有则 null）—— 断连编排据此判断要不要 grace-cancel，
 * `unsubscribe` 则忽略返回值。表项在返回前已删除，因此紧接着调用 `hasViewer` 不会数到
 * 刚走的这一条
 */
function stopViewing(port: chrome.runtime.Port): string | null {
  const previous = viewers.get(port) ?? null;
  viewers.delete(port);
  return previous;
}

/** 是否还有窗口正在看这个会话 */
function hasViewer(sessionId: string): boolean {
  for (const id of viewers.values()) {
    if (id === sessionId) return true;
  }
  return false;
}

/** 投给所有正在看这个会话的窗口（对比传输层的 `broadcastAll` = 所有连接） */
function broadcastToViewers(sessionId: string, msg: ServerMessage): void {
  for (const [port, id] of viewers) {
    if (id === sessionId) post(port, msg);
  }
}

// ─── 公开 API ───

export { setViewing, stopViewing, hasViewer, broadcastToViewers };

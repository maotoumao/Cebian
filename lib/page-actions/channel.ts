// 页面交互的 UX 侧 IPC 入口：内容脚本与侧边栏都从这里向 background 发消息 /
// 订阅指令（background 侧编排在 manager.ts）。仅 UI 上下文导入。

import { browser } from 'wxt/browser';
import {
  PAGE_ACTION_KIND,
  PAGE_ACTION_PORT,
  isCloseSidePanelMessage,
  isPageActionStreamMessage,
  isSuppressMessage,
  type PageActionId,
  type PageActionMessage,
  type PageActionRequest,
} from './types';

function post(msg: PageActionMessage): void {
  // 一次性 fire-and-forget；background 可能未就绪 / 无接收者时静默忽略。
  void browser.runtime.sendMessage(msg).catch(() => {});
}

/** 内容脚本：点击悬浮球，请求 toggle 当前窗口的侧边栏。 */
export function toggleSidePanel(): void {
  post({ kind: PAGE_ACTION_KIND, type: 'toggle_sidepanel' });
}

/** 侧边栏：上报「本窗口侧边栏已打开」。 */
export function reportSidePanelPresent(windowId: number): void {
  post({ kind: PAGE_ACTION_KIND, type: 'sidepanel_present', windowId });
}

/** 侧边栏：上报「本窗口侧边栏即将关闭」。 */
export function reportSidePanelGone(windowId: number): void {
  post({ kind: PAGE_ACTION_KIND, type: 'sidepanel_gone', windowId });
}

/** 侧边栏：订阅 background 的「自关」指令（仅命中自身 windowId 时回调）。返回退订函数。 */
export function subscribeCloseSidePanel(selfWindowId: number, onClose: () => void): () => void {
  const listener = (m: unknown): void => {
    if (isCloseSidePanelMessage(m) && m.windowId === selfWindowId) onClose();
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}

/** 内容脚本：点「在侧边栏继续」——把本次划词交互（原文 + 已生成结果）交给 background
 *  固化成会话并开侧边栏。 */
export function continueInSidePanel(
  actionId: PageActionId,
  text: string,
  result: string,
): void {
  post({ kind: PAGE_ACTION_KIND, type: 'continue_in_sidepanel', actionId, text, result });
}

/** 内容脚本：订阅 background 的「抑制 UI」开关（录制进行中）。返回退订函数。 */
export function subscribeSuppress(cb: (on: boolean) => void): () => void {
  const listener = (m: unknown): void => {
    if (isSuppressMessage(m)) cb(m.on);
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}

/** 内容脚本：挂载时回报存在，让 background 把当前抑制态推回（应对录制中途导航 /
 *  晚挂载错过 on 广播）。 */
export function announcePresent(): void {
  post({ kind: PAGE_ACTION_KIND, type: 'present' });
}

/** {@link runPageAction} 的流式回调。 */
export interface PageActionStreamHandlers {
  onDelta: (delta: string) => void;
  onDone: () => void;
  onError: (message?: string) => void;
}

/**
 * 内容脚本：发起一次划词动作（翻译 / 解释）并接收流式结果。开一个专用端口把请求发给
 * background，chunk / done / error 经同端口回传。返回一个取消函数——断开端口即中止
 * （background 侧监听 onDisconnect 触发 AbortSignal）。回调至多触发一次终态
 * （onDone / onError）。
 */
export function runPageAction(
  request: PageActionRequest,
  handlers: PageActionStreamHandlers,
): () => void {
  const port = browser.runtime.connect({ name: PAGE_ACTION_PORT });
  let settled = false;
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };

  port.onMessage.addListener((msg: unknown) => {
    if (!isPageActionStreamMessage(msg)) return;
    if (msg.type === 'chunk') handlers.onDelta(msg.delta);
    else if (msg.type === 'done') settle(handlers.onDone);
    else settle(() => handlers.onError(msg.message));
  });
  port.onDisconnect.addListener(() => {
    // background 收尾后会主动断开；若终态已到达则忽略，否则视为异常中断。
    settle(() => handlers.onError());
  });

  port.postMessage(request);

  return () => {
    try {
      port.disconnect();
    } catch {
      // 端口已断开，忽略
    }
  };
}

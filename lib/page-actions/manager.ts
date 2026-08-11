// 页面交互的 background 侧编排：接收内容脚本 / 侧边栏消息，处理悬浮球的
// open/close toggle。仅 background 导入。
//
// toggle 的关键约束：`chrome.sidePanel.open()` 必须在用户手势的同一 tick 内同步调用，
// 否则 Chrome 会以「需要用户手势」拒绝。因此 open/close 的判定不能先 await（如
// getContexts），而是读一份**同步维护**的开启态集合 `openPanelWindows`：
//   - 侧边栏挂载 / 卸载时经 sidepanel_present / sidepanel_gone 上报，实时增删
//   - SW 启动时用 getContexts 兜底重建一次（应对 SW 重启丢失内存态）
//   - 打开后再异步 getContexts 对账（关闭分支不对账，否则会把尚未真正关闭
//     的面板重新观测成「开着」而回填；关闭的最终纠正交给侧边栏关闭前上报的 sidepanel_gone）

import { browser, type Browser } from 'wxt/browser';
import {
  isPageActionMessage,
  isPageActionRequest,
  CLOSE_SIDEPANEL_KIND,
  PAGE_ACTION_PORT,
  type PageActionId,
  type PageActionRequest,
  type PageActionStreamMessage,
} from './types';

/**
 * 执行一次划词动作的流式 LLM 调用。由 background 注入（它耦合 resolveProviderApiKey 等
 * background 专属逻辑，lib 不反向 import entrypoints）。成功时 resolve，失败时 throw。
 */
export type PageActionStreamRunner = (
  request: PageActionRequest,
  handlers: { onDelta: (delta: string) => void; signal: AbortSignal },
) => Promise<void>;

/** setupPageActions 需要的 background 侧回调（均由 background 注入）。 */
export interface PageActionHandlers {
  runStream: PageActionStreamRunner;
  /** 把一次划词交互固化成会话并写 pending 交接标记（做法2）；windowId 用于定向对应窗口。 */
  materializeHandoff: (
    req: { actionId: PageActionId; text: string; result: string },
    windowId: number,
  ) => Promise<void>;
  /** 内容脚本挂载时回报当前抑制态（应对录制中途导航 / 晚挂载错过 on 广播）。 */
  onContentPresent: (tabId: number) => void;
}

/** 当前侧边栏处于打开状态的窗口 id 集合（同步维护，供 toggle 即时决策）。 */
const openPanelWindows = new Set<number>();

/** 用 getContexts 重建开启态集合。best-effort：失败仅告警不抛。 */
async function refreshOpenPanels(): Promise<void> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['SIDE_PANEL' as chrome.runtime.ContextType],
    });
    openPanelWindows.clear();
    for (const ctx of contexts) {
      if (typeof ctx.windowId === 'number' && ctx.windowId >= 0) {
        openPanelWindows.add(ctx.windowId);
      }
    }
  } catch (err) {
    console.warn('[page-actions] refreshOpenPanels failed:', err);
  }
}

/** toggle 指定窗口的侧边栏：开着→令其自关；没开→打开。判定与 sidePanel.open 全程
 *  同步，保住内容脚本点击传来的用户手势。 */
function toggleSidePanel(windowId: number): void {
  if (openPanelWindows.has(windowId)) {
    // 关闭：乐观置为关闭并令面板自关。不在此立即 getContexts 对账——此刻面板尚未
    // 真正关闭，getContexts 会把它重新观测为「开着」而回填，反而制造污染；最终纠正
    // 交给侧边栏关闭前上报的 sidepanel_gone。
    openPanelWindows.delete(windowId);
    void browser.runtime
      .sendMessage({ kind: CLOSE_SIDEPANEL_KIND, windowId })
      .catch(() => {});
  } else {
    openPanelWindows.add(windowId);
    chrome.sidePanel.open({ windowId }).catch((err) => {
      openPanelWindows.delete(windowId);
      console.warn('[page-actions] sidePanel.open failed:', err);
    });
    // 打开后对账安全：getContexts 会稳定观测到已打开的面板。
    void refreshOpenPanels();
  }
}

/** 处理一条划词动作流式端口：收到请求后跑注入的 runner，chunk / done / error 经同端口
 *  回传；端口断开（用户关卡 / 换选区）即 abort。 */
function handlePageActionPort(
  port: Browser.runtime.Port,
  runStream: PageActionStreamRunner,
): void {
  const controller = new AbortController();
  let started = false;
  const post = (m: PageActionStreamMessage) => {
    try {
      port.postMessage(m);
    } catch {
      // 端口已断，忽略
    }
  };
  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener((msg: unknown) => {
    // 每个端口只服务一次请求。
    if (started || !isPageActionRequest(msg)) return;
    started = true;
    runStream(msg, {
      signal: controller.signal,
      onDelta: (delta) => post({ type: 'chunk', delta }),
    })
      .then(() => post({ type: 'done' }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.warn('[page-actions] stream failed:', err);
        post({ type: 'error', message: err?.message ?? String(err) });
      })
      .finally(() => {
        try {
          port.disconnect();
        } catch {
          // 已断开，忽略
        }
      });
  });
}

/** 防重复注册的一次性守卫（setupPageActions 应每个 background 上下文只调一次）。 */
let pageActionsSetup = false;

/** 注册页面交互的 runtime 消息处理器。在 background 启动时调用一次。
 *  `runStream` 由 background 注入（见 PageActionStreamRunner）。 */
export function setupPageActions(handlers: PageActionHandlers): void {
  if (pageActionsSetup) return;
  pageActionsSetup = true;
  void refreshOpenPanels();
  browser.runtime.onConnect.addListener((port) => {
    if (port.name === PAGE_ACTION_PORT) handlePageActionPort(port, handlers.runStream);
  });
  browser.runtime.onMessage.addListener((msg, sender) => {
    if (!isPageActionMessage(msg)) return;
    switch (msg.type) {
      case 'toggle_sidepanel': {
        const windowId = sender.tab?.windowId;
        if (typeof windowId === 'number' && windowId >= 0) toggleSidePanel(windowId);
        break;
      }
      case 'sidepanel_present':
        openPanelWindows.add(msg.windowId);
        break;
      case 'sidepanel_gone':
        openPanelWindows.delete(msg.windowId);
        break;
      case 'continue_in_sidepanel': {
        const windowId = sender.tab?.windowId;
        if (typeof windowId === 'number' && windowId >= 0) {
          // 同步开面板保住用户手势；随后异步固化会话 + 写 pending（侧边栏监听到即跳转）。
          openPanelWindows.add(windowId);
          chrome.sidePanel.open({ windowId }).catch((err) => {
            openPanelWindows.delete(windowId);
            console.warn('[page-actions] open for continue failed:', err);
          });
          void handlers
            .materializeHandoff(
              { actionId: msg.actionId, text: msg.text, result: msg.result },
              windowId,
            )
            .catch((err) => console.warn('[page-actions] materialize handoff failed:', err));
        }
        break;
      }
      case 'present': {
        const tabId = sender.tab?.id;
        if (typeof tabId === 'number') handlers.onContentPresent(tabId);
        break;
      }
    }
    // 不发送异步响应
    return undefined;
  });
}

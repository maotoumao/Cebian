// 页面交互（悬浮球 + 划词工具条）跨上下文消息契约。
//
// 内容脚本 / 侧边栏 ↔ background 走独立于 AGENT_PORT 的一次性 runtime 消息通道。
// 这里只放「与执行上下文无关」的消息形状与守卫，供三边共享。

/** 页面交互 runtime 消息的统一 kind 标记（区分于 recorder 等其它 runtime 消息）。 */
export const PAGE_ACTION_KIND = 'cebian_page_action';

/**
 * 内容脚本 / 侧边栏 → background 的消息：
 * - `toggle_sidepanel`：内容脚本点击悬浮球，请求 toggle 发起窗口的侧边栏（windowId
 *   由 background 从 `sender.tab` 读取）
 * - `sidepanel_present` / `sidepanel_gone`：侧边栏上报自身开启态，供 background 同步
 *   维护「哪些窗口的侧边栏开着」，让 toggle 能同步决策（保住打开侧边栏所需的用户手势）
 */
export type PageActionMessage =
  | { kind: typeof PAGE_ACTION_KIND; type: 'toggle_sidepanel' }
  | { kind: typeof PAGE_ACTION_KIND; type: 'sidepanel_present'; windowId: number }
  | { kind: typeof PAGE_ACTION_KIND; type: 'sidepanel_gone'; windowId: number }
  | { kind: typeof PAGE_ACTION_KIND; type: 'present' }
  | {
      kind: typeof PAGE_ACTION_KIND;
      type: 'continue_in_sidepanel';
      actionId: PageActionId;
      text: string;
      result: string;
    };

/** background → 侧边栏的「自关」指令。Chrome 无 sidePanel.close API，只能让目标窗口的
 *  侧边栏自己 `window.close()`；windowId 用于多窗口时精确命中。 */
export const CLOSE_SIDEPANEL_KIND = 'cebian_close_sidepanel';

export interface CloseSidePanelMessage {
  kind: typeof CLOSE_SIDEPANEL_KIND;
  windowId: number;
}

export function isCloseSidePanelMessage(m: unknown): m is CloseSidePanelMessage {
  return (
    typeof m === 'object' &&
    m !== null &&
    (m as { kind?: unknown }).kind === CLOSE_SIDEPANEL_KIND &&
    typeof (m as { windowId?: unknown }).windowId === 'number'
  );
}

export function isPageActionMessage(m: unknown): m is PageActionMessage {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  if (r.kind !== PAGE_ACTION_KIND) return false;
  if (r.type === 'toggle_sidepanel' || r.type === 'present') return true;
  if (r.type === 'sidepanel_present' || r.type === 'sidepanel_gone') {
    return typeof r.windowId === 'number';
  }
  if (r.type === 'continue_in_sidepanel') {
    return (
      isPageActionId(r.actionId) &&
      typeof r.text === 'string' &&
      typeof r.result === 'string'
    );
  }
  return false;
}

/** background → 内容脚本的「抑制页面 UI」指令（录制进行中）。发往被观察的录制 tab，
 *  让悬浮球 / 工具条隐藏，避免误点击与噪声。（取词 picker 由内容脚本自行观察 DOM。） */
export const SUPPRESS_KIND = 'cebian_page_action_suppress';

export interface SuppressMessage {
  kind: typeof SUPPRESS_KIND;
  on: boolean;
}

export function isSuppressMessage(m: unknown): m is SuppressMessage {
  return (
    typeof m === 'object' &&
    m !== null &&
    (m as { kind?: unknown }).kind === SUPPRESS_KIND &&
    typeof (m as { on?: unknown }).on === 'boolean'
  );
}

// ─── 划词动作（翻译 / 解释）流式契约 ───

/** 内置动作 id。数据驱动：动作差异收敛成一份定义（见 lib/page-actions/actions.ts），
 *  扩展只需往注册表加条目，IPC 契约用 id + params，无需改协议。 */
export type PageActionId = 'translate' | 'explain' | 'summarize';

export function isPageActionId(v: unknown): v is PageActionId {
  return v === 'translate' || v === 'explain' || v === 'summarize';
}

/** 划词动作的流式端口名（独立于 AGENT_PORT）。 */
export const PAGE_ACTION_PORT = 'cebian-page-action';

/**
 * 内容脚本 → background 的动作请求（经 PAGE_ACTION_PORT 端口发送）。只带原始素材，
 * 由 background 侧按 actionId 查定义、解析 params、构造提示词（「转换在 handler」）。
 * `params` 泛化预留给将来的自定义动作参数；v1 内置动作的参数由 background 读设置解析。
 */
export interface PageActionRequest {
  actionId: PageActionId;
  text: string;
  params: Record<string, unknown>;
}

/** background → 内容脚本的流式回传（同一端口）。 */
export type PageActionStreamMessage =
  | { type: 'chunk'; delta: string }
  | { type: 'done' }
  | { type: 'error'; message?: string };

export function isPageActionRequest(m: unknown): m is PageActionRequest {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  return (
    isPageActionId(r.actionId) &&
    typeof r.text === 'string' &&
    typeof r.params === 'object' &&
    r.params !== null
  );
}

export function isPageActionStreamMessage(m: unknown): m is PageActionStreamMessage {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Record<string, unknown>;
  if (r.type === 'chunk') return typeof r.delta === 'string';
  if (r.type === 'done') return true;
  if (r.type === 'error') return r.message === undefined || typeof r.message === 'string';
  return false;
}

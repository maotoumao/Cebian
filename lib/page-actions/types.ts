// 页面交互（悬浮球 + 划词工具条）跨上下文消息契约。
//
// 页面生效范围（PageScope）的形状与判定住在同目录的 match.ts——它同时服务悬浮球 /
// 工具条的设置与单个动作的配置，不专属于动作。
//
// 内容脚本 / 侧边栏 ↔ background 走独立于 AGENT_PORT 的一次性 runtime 消息通道。
// 这里只放「与执行上下文无关」的消息形状与守卫，供三边共享。

import type { PageScope } from './match';

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

/**
 * 内置动作 id 的单一真理源：类型由数组推导，守卫复用同一数组，注册表用
 * `satisfies Record<BuiltinPageActionId, …>` 保持穷尽——三处不会各自漂移。
 * 数组顺序即工具条上内置动作的缺省顺序。
 *
 * 内置动作的提示词定义在代码里（见 lib/page-actions/actions.ts），用户只能通过
 * overlay 调整其外观 / 生效范围，不能改提示词。
 */
export const BUILTIN_PAGE_ACTION_IDS = ['explain', 'translate', 'summarize'] as const;

export type BuiltinPageActionId = (typeof BUILTIN_PAGE_ACTION_IDS)[number];

export function isBuiltinPageActionId(v: unknown): v is BuiltinPageActionId {
  return typeof v === 'string' && (BUILTIN_PAGE_ACTION_IDS as readonly string[]).includes(v);
}

/**
 * 动作 id：内置固定字面量，或用户自定义动作的 `custom-<hex>`。类型放宽成 string
 * （用户数据里的 id 搬不进字面量联合），但**格式**仍是收紧的白名单——见
 * `isPageActionId`。「这个 id 有没有对应定义」另由 background 查表时诚实报错。
 */
export type PageActionId = string;

/** 自定义动作 id 的形态；与 `newCustomPageActionId` 是同一约定的两面，必须同步改。 */
const CUSTOM_PAGE_ACTION_ID_RE = /^custom-[a-z0-9]{8,}$/;

/** 生成一个自定义动作 id。创建时调用一次，之后永不变（order / overlay 按它索引）。 */
export function newCustomPageActionId(): string {
  return `custom-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * id 格式校验。只认内置 id 与 `custom-<hex>`，故 `__proto__` / `constructor` 这类
 * 原型键不可能通过——它们曾能绕过「查得到定义」那道防线（注册表按 id 索引普通对象），
 * 在这里就地挡住比依赖每个查表点自己防御更可靠。
 */
export function isPageActionId(v: unknown): v is PageActionId {
  if (typeof v !== 'string') return false;
  return isBuiltinPageActionId(v) || CUSTOM_PAGE_ACTION_ID_RE.test(v);
}

// ─── 划词动作配置（用户可配置层） ───

/**
 * 用户自定义划词动作。`systemPrompt` 是模板，支持 `{{变量}}`（见
 * lib/ai-config/template.ts 的环境变量表）；user turn 固定为选中文本，与内置动作
 * 保持同一架构，「在侧边栏继续」固化的历史才读起来自然。
 */
export interface CustomPageAction {
  /** `custom-<随机串>`，创建时生成后永不改（order / overlay 都按它索引）。 */
  id: string;
  /** 按钮文本。用户原样输入，不走 i18n。 */
  label: string;
  /** 是否显示在工具条上。缺省 = true（与内置动作的 overlay 同语义，设置里共用一列开关）。 */
  enabled?: boolean;
  /** system 提示词模板。 */
  systemPrompt: string;
  /** 页面生效范围；缺省 = 不限制（所有页面）。 */
  pages?: PageScope;
  /** 输出后处理脚本（函数体，入参 text / vars，返回字符串）；缺省 = 不做后处理。 */
  transform?: string;
}

/** 内置动作的用户覆盖层。字段缺省即「用默认」，不写就是没改过。 */
export interface BuiltinActionOverlay {
  /** 是否显示在工具条上。缺省 = true。 */
  enabled?: boolean;
  /** 覆盖按钮文本；缺省 / 空串 = 回落 i18n 文案（跟随界面语言）。 */
  label?: string;
  /** 页面生效范围；缺省 = 不限制（所有页面）。 */
  pages?: PageScope;
  /** 输出后处理脚本；缺省 = 不做后处理。 */
  transform?: string;
}

/**
 * 编辑中的动作（设置页表单的形状）。内置与自定义共用一份表单，差异只体现在：
 * 内置的 `systemPrompt` 不可改（表单不展示），`kind` 决定写回配置时落到 overlay
 * 还是 custom 数组。空串即「没设置」、页面范围两个列表都空即「不限制」，写回时都会被省略。
 */
export interface PageActionDraft {
  id: string;
  kind: 'builtin' | 'custom';
  label: string;
  systemPrompt: string;
  pages: PageScope;
  transform: string;
  /**
   * 翻译目标语言（BCP-47；空串 = 跟随界面语言）。**只有内置「翻译」动作用它**——它是
   * 那个动作的专属参数，故随表单一起缓冲、一起保存。
   *
   * 注意它不落在 `pageActionsConfig` 里，而是继续写回
   * `pageInteractionSettings.translateTarget`：那个 key 早于本次改动就已发布，是既有的
   * 持久化契约，只搬 UI 位置、不搬存储位置。
   */
  translateTarget?: string;
}

/** 划词动作的全量配置。 */
export interface PageActionsConfig {
  /** 内置动作覆盖层，按内置 id 索引。 */
  builtin: Partial<Record<BuiltinPageActionId, BuiltinActionOverlay>>;
  /** 用户自定义动作。 */
  custom: CustomPageAction[];
  /** 工具条按钮顺序（内置 + 自定义 id 混排）；缺省 / 未列出的按内置在前、自定义按数组序补在后。 */
  order?: string[];
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

/**
 * background → 内容脚本的流式回传（同一端口）。
 *
 * `done` 上的 transform 结果只能在全文生成完后才有，且三种结局互斥（建模成联合，
 * 避免「两个字段同时出现时该信谁」这种协议歧义）：
 * - 都不带：动作没配 transform，展示原始输出
 * - `transformed`：用它替换展示与复制内容（原始输出仍用于「在侧边栏继续」的固化）
 * - `transformError`：脚本执行失败，展示降级为原文 + 提示
 */
/**
 * 一次动作跑完后的收尾结局：输出后处理（transform）的三种互斥结果。`done` 消息、
 * background 侧 runner 的返回值、内容脚本的 onDone 回调共用这一个类型，避免同一
 * 概念在三处各写一份、其中一处又把互斥约束放宽。
 */
export type PageActionOutcome =
  | { transformed?: undefined; transformError?: undefined }
  | { transformed: string; transformError?: undefined }
  | { transformed?: undefined; transformError: string };

export type PageActionStreamMessage =
  | { type: 'chunk'; delta: string }
  | { type: 'done'; transformed?: undefined; transformError?: undefined }
  | { type: 'done'; transformed: string; transformError?: undefined }
  | { type: 'done'; transformed?: undefined; transformError: string }
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
  if (r.type === 'done') {
    // 两个字段互斥：同时出现视为非法消息，不让歧义流进展示层。
    if (r.transformed !== undefined && r.transformError !== undefined) return false;
    return (
      (r.transformed === undefined || typeof r.transformed === 'string') &&
      (r.transformError === undefined || typeof r.transformError === 'string')
    );
  }
  if (r.type === 'error') return r.message === undefined || typeof r.message === 'string';
  return false;
}

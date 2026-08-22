// 划词动作的定义注册表 + 纯渲染函数（domain content，随概念走）。
//
// 数据驱动：每个动作是一条 PageActionDef，用 id 索引；renderSystemPrompt /
// renderUserIntent 是无平台依赖的纯函数，内联短暂调用与（后续）会话固化共用同一
// 渲染源，保证「怎么问」单一事实源、零漂移。动作指令（如「只输出译文」）放 system
// prompt，user turn 只放干净意图，便于将来固化进历史时读起来自然。

import { t } from '@/lib/i18n';
import { replaceTemplateVars } from '@/lib/ai-config/template';
import { matchesPageScope, resolvePageScope, type PageScope } from './match';
import {
  BUILTIN_PAGE_ACTION_IDS,
  isBuiltinPageActionId,
  isPageActionId,
  type BuiltinPageActionId,
  type CustomPageAction,
  type PageActionId,
  type PageActionsConfig,
} from './types';

/** 渲染用参数（已由 background 解析成具体值，如目标语言名）。 */
export type PageActionParams = Record<string, unknown>;

interface PageActionDef {
  id: PageActionId;
  /** 缺省按钮文本（内置动作跟随界面语言；用户 overlay 可覆盖）。 */
  getLabel(): string;
  /** LLM 的 system 提示词（含动作指令）。 */
  renderSystemPrompt(params: PageActionParams): string;
  /** 干净的用户意图（作为 user turn；将来固化进历史也用它）。 */
  renderUserIntent(text: string, params: PageActionParams): string;
}

function str(params: PageActionParams, key: string, fallback: string): string {
  const v = params[key];
  return typeof v === 'string' && v ? v : fallback;
}

/** 若带有界上下文（页面标题 + 选区周边），拼成一段「仅供消歧的参考」附在 system 末尾。
 *  只进 system、不进 user turn，故「在侧边栏继续」固化的历史里 user 消息仍是干净意图。 */
function contextBlock(params: PageActionParams): string {
  const ctx = str(params, 'context', '');
  if (!ctx) return '';
  return (
    '\n\nFor reference only, here is surrounding context from the page. ' +
    'Use it to disambiguate; do NOT translate, explain, or summarize the context itself:\n' +
    ctx
  );
}

const TRANSLATE: PageActionDef = {
  id: 'translate',
  getLabel: () => t('pageActions.toolbar.translate'),
  renderSystemPrompt: (p) => {
    const target = str(p, 'target', 'English');
    return (
      `You are a professional translator. Translate the user's text into ${target}. ` +
      'Preserve the original meaning and tone. ' +
      'Output only the translated text as plain text — no markdown, explanations, notes, or surrounding quotes.' +
      contextBlock(p)
    );
  },
  renderUserIntent: (text, p) => {
    const target = str(p, 'target', 'English');
    return `Translate into ${target}:\n\n${text}`;
  },
};

const EXPLAIN: PageActionDef = {
  id: 'explain',
  getLabel: () => t('pageActions.toolbar.explain'),
  renderSystemPrompt: (p) => {
    const lang = str(p, 'lang', "the user's language");
    return (
      `You are a helpful assistant. Explain the user's selected text clearly and concisely ` +
      `in ${lang}. Cover what it means and any important context a reader would want. ` +
      'Keep it brief. Reply in plain prose without markdown formatting.' +
      contextBlock(p)
    );
  },
  renderUserIntent: (text) => `Explain:\n\n${text}`,
};

const SUMMARIZE: PageActionDef = {
  id: 'summarize',
  getLabel: () => t('pageActions.toolbar.summarize'),
  renderSystemPrompt: (p) => {
    const lang = str(p, 'lang', "the user's language");
    return (
      `You are a helpful assistant. Summarize the user's selected text in ${lang}, ` +
      'capturing the key points concisely. ' +
      'Reply in plain prose (short sentences or a compact list is fine) without markdown formatting.' +
      contextBlock(p)
    );
  },
  renderUserIntent: (text) => `Summarize:\n\n${text}`,
};

// `satisfies Record<BuiltinPageActionId, …>` 保持穷尽：新增内置 id 忘了登记会编译失败。
const REGISTRY = {
  translate: TRANSLATE,
  explain: EXPLAIN,
  summarize: SUMMARIZE,
} satisfies Record<BuiltinPageActionId, PageActionDef>;

/** 按 id 取内置动作定义；未知 id 返回 undefined（由调用方诚实报错）。
 *  用 `Object.hasOwn` 而非直接索引——否则 `__proto__` / `constructor` 会取到
 *  Object.prototype 上的成员，绕过调用方「查不到就报错」的防线。 */
function getBuiltinAction(id: string): PageActionDef | undefined {
  return Object.hasOwn(REGISTRY, id)
    ? (REGISTRY as Record<string, PageActionDef>)[id]
    : undefined;
}

// ─── 生效动作的解析（配置 + 当前页 → 实际可用的动作） ───

/**
 * 一个已解析的动作：配置合并完、显示文本定好，内置与自定义同一形状。
 * 内容脚本用 id / label 渲染按钮，background 用渲染函数与 transform，设置页用
 * enabled / pages 展示与编辑。
 */
export interface ResolvedPageAction {
  id: PageActionId;
  /** 最终显示文本（内置的界面文案已与用户 overlay 合并完）。 */
  label: string;
  kind: 'builtin' | 'custom';
  /** 是否显示在工具条上（缺省即 true 已在此归一）。 */
  enabled: boolean;
  /** 页面生效范围（已归一：两个列表都在，空 include = 所有页面）。 */
  pages: PageScope;
  /** 输出后处理脚本（函数体）；缺省 = 不做后处理。 */
  transform?: string;
  /** LLM 的 system 提示词（含动作指令）。 */
  renderSystemPrompt(params: PageActionParams): string;
  /** 干净的用户意图（作为 user turn；固化进历史也用它）。 */
  renderUserIntent(text: string, params: PageActionParams): string;
}

/** 自定义动作 → 已解析形状：用户模板即 system 提示词，user turn 仍是干净的选中文本。 */
function resolveCustom(action: CustomPageAction): ResolvedPageAction {
  return {
    id: action.id,
    kind: 'custom',
    label: action.label,
    enabled: action.enabled !== false,
    pages: resolvePageScope(action.pages),
    renderSystemPrompt: (params) =>
      replaceTemplateVars(action.systemPrompt, stringParams(params)),
    renderUserIntent: (text) => text,
    ...(action.transform ? { transform: action.transform } : {}),
  };
}

/** 内置动作 + 用户 overlay → 已解析形状（overlay 只动外观 / 生效范围，不动提示词）。 */
function resolveBuiltin(def: PageActionDef, config: PageActionsConfig): ResolvedPageAction {
  const overlay = Object.hasOwn(config.builtin, def.id)
    ? config.builtin[def.id as BuiltinPageActionId]
    : undefined;
  const label = overlay?.label?.trim();
  return {
    id: def.id,
    kind: 'builtin',
    renderSystemPrompt: def.renderSystemPrompt,
    renderUserIntent: def.renderUserIntent,
    // 用户没起名（或清空了）就回落到跟随界面语言的内置文案。
    label: label || def.getLabel(),
    enabled: overlay?.enabled !== false,
    pages: resolvePageScope(overlay?.pages),
    ...(overlay?.transform ? { transform: overlay.transform } : {}),
  };
}

/** 只保留参数里的字符串值：模板替换与后处理脚本都只吃字符串，非字符串项（不该有）
 *  直接丢掉而不是塞成 "[object Object]"。 */
export function stringParams(params: PageActionParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * 自定义动作里 id 合法且不与内置冲突的那些。
 *
 * 脏配置（手改备份包、旧版本、并发写）可能带来非法 id 或与内置重名的条目：非法 id
 * 会被 IPC 的请求守卫拒掉——按钮点了却永远转圈；与内置重名则让「这个 id 是哪个动作」
 * 有歧义。两种都在此就地丢弃，让整条链路只见到干净数据。
 */
function validCustomActions(config: PageActionsConfig): CustomPageAction[] {
  const seen = new Set<string>();
  return config.custom.filter((a) => {
    if (!isPageActionId(a.id) || isBuiltinPageActionId(a.id) || seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
}

/**
 * 全部动作 id，按工具条顺序：`order` 里认得的 id 在前（按其顺序），其余按缺省顺序补在后面
 * ——内置在前（BUILTIN_PAGE_ACTION_IDS 的顺序），自定义按数组序。
 * `order` 里已不存在的 id 直接忽略，故删动作 / 换设备都不会把顺序搞坏。
 */
export function listPageActionIds(config: PageActionsConfig): string[] {
  const fallback = [
    ...BUILTIN_PAGE_ACTION_IDS,
    ...validCustomActions(config).map((a) => a.id),
  ] as string[];
  if (!config.order) return fallback;
  const known = new Set(fallback);
  // 边去重边过滤：脏数据（手改备份包 / 并发写）里的重复 id 不能变成重复按钮。
  const seen = new Set<string>();
  const listed: string[] = [];
  for (const id of config.order) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    listed.push(id);
  }
  return [...listed, ...fallback.filter((id) => !seen.has(id))];
}

/** 按 id 取已解析动作（不看启停 / 页面规则——background 执行时只关心「这个 id 是什么」）。 */
export function findPageAction(
  config: PageActionsConfig,
  id: string,
): ResolvedPageAction | undefined {
  if (isBuiltinPageActionId(id)) {
    const def = getBuiltinAction(id);
    return def ? resolveBuiltin(def, config) : undefined;
  }
  const custom = validCustomActions(config).find((a) => a.id === id);
  return custom ? resolveCustom(custom) : undefined;
}

/**
 * 全部动作，按工具条顺序——设置页用（要能看见并管理被关掉的动作）。
 * 不做任何过滤：启停与页面规则都作为字段带在结果里。
 */
export function listPageActions(config: PageActionsConfig): ResolvedPageAction[] {
  const out: ResolvedPageAction[] = [];
  for (const id of listPageActionIds(config)) {
    const action = findPageAction(config, id);
    if (action) out.push(action);
  }
  return out;
}

/**
 * 当前页该显示哪些动作、按什么顺序——工具条渲染的唯一入口：
 * 全量列表里滤掉被关掉的与页面范围不命中的。
 *
 * 动作范围是在**工具条范围之内**再收窄：工具条自身不在生效范围时整条都不渲染
 * （见 SelectionToolbar），故这里只判动作自己的范围，两层是天然的「与」关系。
 */
export function visibleToolbarActions(
  config: PageActionsConfig,
  url: string,
): ResolvedPageAction[] {
  return listPageActions(config).filter((a) => a.enabled && matchesPageScope(url, a.pages));
}

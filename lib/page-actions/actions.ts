// 划词动作的定义注册表 + 纯渲染函数（domain content，随概念走）。
//
// 数据驱动：每个内置动作只登记缺省按钮文本与缺省 system prompt。配置解析后，内置与
// 自定义动作共用同一个模板渲染器；user turn 都只放选中文本。

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
type PageActionParams = Record<string, unknown>;

interface PageActionDef {
  id: PageActionId;
  /** 按钮文本（内置动作固定跟随界面语言）。 */
  getLabel(): string;
  /** 本地化的缺省 system 提示词模板。 */
  getSystemPrompt(): string;
}

const TRANSLATE: PageActionDef = {
  id: 'translate',
  getLabel: () => t('pageActions.toolbar.translate'),
  getSystemPrompt: () =>
    t('pageActions.prompts.translate', ['{{ui_language}}', '{{context}}']),
};

const EXPLAIN: PageActionDef = {
  id: 'explain',
  getLabel: () => t('pageActions.toolbar.explain'),
  getSystemPrompt: () =>
    t('pageActions.prompts.explain', ['{{ui_language}}', '{{context}}']),
};

const SUMMARIZE: PageActionDef = {
  id: 'summarize',
  getLabel: () => t('pageActions.toolbar.summarize'),
  getSystemPrompt: () =>
    t('pageActions.prompts.summarize', ['{{ui_language}}', '{{context}}']),
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

/** 取内置动作当前语言的缺省 system 提示词 */
function getBuiltinDefaultSystemPrompt(id: BuiltinPageActionId): string {
  return REGISTRY[id].getSystemPrompt();
}

/** 取内置动作当前语言的缺省按钮文本 */
function getBuiltinDefaultLabel(id: BuiltinPageActionId): string {
  return REGISTRY[id].getLabel();
}

// ─── 生效动作的解析（配置 + 当前页 → 实际可用的动作） ───

/**
 * 一个已解析的动作：配置合并完、显示文本定好，内置与自定义同一形状。
 * 内容脚本用 id / label 渲染按钮，background 用渲染函数与 transform，设置页用
 * enabled / pages 展示与编辑。
 */
export interface ResolvedPageAction {
  id: PageActionId;
  /** 最终显示文本（内置动作固定使用界面文案）。 */
  label: string;
  kind: 'builtin' | 'custom';
  /** 是否显示在工具条上（缺省即 true 已在此归一）。 */
  enabled: boolean;
  /** 页面生效范围（已归一：两个列表都在，空 include = 所有页面）。 */
  pages: PageScope;
  /** 输出后处理脚本（完整的 `transform(text, vars)` 函数）；缺省 = 不做后处理。 */
  transform?: string;
  /** LLM 的 system 提示词（含动作指令）。 */
  renderSystemPrompt(params: PageActionParams): string;
}

/** 自定义动作 → 已解析形状：用户模板即 system 提示词，user turn 仍是干净的选中文本。 */
function resolveCustom(action: CustomPageAction): ResolvedPageAction {
  return {
    id: action.id,
    kind: 'custom',
    label: action.label,
    enabled: action.enabled !== false,
    pages: resolvePageScope(action.pages),
    renderSystemPrompt: renderSystemPrompt(action.systemPrompt),
    ...(action.transform ? { transform: action.transform } : {}),
  };
}

/** 内置动作 + 用户 overlay → 已解析形状；prompt 未覆盖时回落当前语言的缺省模板。 */
function resolveBuiltin(def: PageActionDef, config: PageActionsConfig): ResolvedPageAction {
  const overlay = Object.hasOwn(config.builtin, def.id)
    ? config.builtin[def.id as BuiltinPageActionId]
    : undefined;
  const systemPrompt = overlay?.systemPrompt?.trim()
    ? overlay.systemPrompt
    : def.getSystemPrompt();
  return {
    id: def.id,
    kind: 'builtin',
    renderSystemPrompt: renderSystemPrompt(systemPrompt),
    label: def.getLabel(),
    enabled: overlay?.enabled !== false,
    pages: resolvePageScope(overlay?.pages),
    ...(overlay?.transform ? { transform: overlay.transform } : {}),
  };
}

/** system prompt 模板统一渲染入口：内置与自定义动作共用。 */
function renderSystemPrompt(template: string): (params: PageActionParams) => string {
  return (params) => replaceTemplateVars(template, stringParams(params));
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

export { getBuiltinDefaultLabel, getBuiltinDefaultSystemPrompt };

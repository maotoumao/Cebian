// 划词动作配置的编辑操作（纯函数，设置 UI 用）。
//
// 与 actions.ts 分工：那边把配置**读**成生效动作，这边把用户的编辑**写**回配置。
// 全部返回新对象、不改入参，故 React 状态与 storage 写入都安全。
//
// 写回时省略空字段（空 label / 空 pages / 空 transform 一律不落库），让存下来的配置
// 只包含用户真正改过的东西——既省空间，也让「用户到底改了什么」在备份 JSON 里一眼可见。

import { listPageActionIds } from './actions';
import { isUnrestrictedPageScope, type PageScope } from './match';
import {
  isBuiltinPageActionId,
  newCustomPageActionId,
  type BuiltinActionOverlay,
  type CustomPageAction,
  type PageActionDraft,
  type PageActionsConfig,
} from './types';

/**
 * 空白草稿：新建自定义动作时用（id 此刻就定下，之后永不变）。
 *
 * 传入当前配置以避开已占用的 id——随机碰撞概率极低，但真撞上就是静默覆盖别人的动作。
 */
function newActionDraft(config: PageActionsConfig): PageActionDraft {
  const taken = new Set(listPageActionIds(config));
  let id = newCustomPageActionId();
  while (taken.has(id)) id = newCustomPageActionId();
  return {
    id,
    kind: 'custom',
    label: '',
    systemPrompt: '',
    pages: { include: [], exclude: [] },
    transform: '',
  };
}

/** 只在范围真有限制时给出可落库的副本；没做任何限制则 undefined（与空 label / 空脚本
 *  同理，不落库）。 */
function pageScopeIfRestricted(scope: PageScope): PageScope | undefined {
  if (isUnrestrictedPageScope(scope)) return undefined;
  return { include: [...scope.include], exclude: [...scope.exclude] };
}

/** 内置动作的 overlay：只留用户真正改过的字段，全空则整条删掉。 */
function overlayFrom(
  draft: PageActionDraft,
  previous: BuiltinActionOverlay | undefined,
): BuiltinActionOverlay | undefined {
  const label = draft.label.trim();
  const transform = draft.transform.trim();
  const pages = pageScopeIfRestricted(draft.pages);
  const next: BuiltinActionOverlay = {
    // enabled 由列表上的开关维护，编辑页只是原样带过去。只保留 false——`enabled: true`
    // 与默认完全等价，留着就成了「看起来改过其实没改」的空壳。
    ...(previous?.enabled === false ? { enabled: false } : {}),
    ...(label ? { label } : {}),
    ...(pages ? { pages } : {}),
    ...(transform ? { transform } : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

/** 把一份草稿写回配置：内置动作写 overlay，自定义动作整条 upsert（新建则追加）。 */
function saveActionDraft(
  config: PageActionsConfig,
  draft: PageActionDraft,
): PageActionsConfig {
  if (isBuiltinPageActionId(draft.id)) {
    const builtin = { ...config.builtin };
    const overlay = overlayFrom(draft, builtin[draft.id]);
    if (overlay) builtin[draft.id] = overlay;
    else delete builtin[draft.id];
    return { ...config, builtin };
  }

  const transform = draft.transform.trim();
  const pages = pageScopeIfRestricted(draft.pages);
  const existing = config.custom.find((a) => a.id === draft.id);
  const next: CustomPageAction = {
    id: draft.id,
    label: draft.label.trim(),
    systemPrompt: draft.systemPrompt,
    // enabled 由列表上的开关维护；省略即启用，故只有关掉状态需要落库。
    ...(existing?.enabled === false ? { enabled: false } : {}),
    ...(pages ? { pages } : {}),
    ...(transform ? { transform } : {}),
  };
  const custom = existing
    ? config.custom.map((a) => (a.id === draft.id ? next : a))
    : [...config.custom, next];
  return { ...config, custom };
}

/**
 * 启停一个动作（内置写 overlay.enabled，自定义写自身字段）。
 *
 * 启用是默认值，故重新开启时把 `enabled` 字段整个去掉，而不是写 `true`：配置里只留
 * 用户真正偏离默认的部分，overlay 因此变空就连整条一起删。
 */
function setActionEnabled(
  config: PageActionsConfig,
  id: string,
  enabled: boolean,
): PageActionsConfig {
  if (isBuiltinPageActionId(id)) {
    const builtin = { ...config.builtin };
    if (enabled) {
      const { enabled: _wasEnabled, ...rest } = builtin[id] ?? {};
      if (Object.keys(rest).length > 0) builtin[id] = rest;
      else delete builtin[id];
    } else {
      builtin[id] = { ...builtin[id], enabled: false };
    }
    return { ...config, builtin };
  }
  return {
    ...config,
    custom: config.custom.map((a) => {
      if (a.id !== id) return a;
      if (!enabled) return { ...a, enabled: false };
      const { enabled: _wasEnabled, ...rest } = a;
      return rest;
    }),
  };
}

/** 删除一个自定义动作（内置动作只能关，不能删）。顺序里的残留 id 一并清掉。 */
function deleteCustomAction(config: PageActionsConfig, id: string): PageActionsConfig {
  if (isBuiltinPageActionId(id)) return config;
  return {
    ...config,
    custom: config.custom.filter((a) => a.id !== id),
    ...(config.order ? { order: config.order.filter((o) => o !== id) } : {}),
  };
}

/**
 * 把一个动作在工具条上前移 / 后移一格。
 *
 * 落库的是**完整顺序**而不是相对位置：`order` 只在这里被写，写的是当下解析出的全量
 * 顺序，故此后新增动作照旧补在末尾，不会因为「部分顺序」产生歧义。已在两端时原样返回。
 */
function moveAction(config: PageActionsConfig, id: string, delta: -1 | 1): PageActionsConfig {
  const ids = listPageActionIds(config);
  const from = ids.indexOf(id);
  if (from < 0) return config;
  const to = from + delta;
  if (to < 0 || to >= ids.length) return config;
  const order = [...ids];
  [order[from], order[to]] = [order[to], order[from]];
  return { ...config, order };
}

export {
  newActionDraft,
  saveActionDraft,
  setActionEnabled,
  deleteCustomAction,
  moveAction,
};

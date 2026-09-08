// 搜索引擎配置的编辑操作（纯函数，设置 UI 用）。
//
// 与 engines.ts 分工：那边把配置**读**成生效引擎，这边把用户的编辑**写**回配置。
// 全部返回新对象、不改入参，故 React 状态与 storage 写入都安全。
//
// 写回时省略与默认相同 / 为空的字段，让存下来的配置只包含用户真正改过的东西——
// 既省空间，也让「用户到底改了什么」在备份 JSON 里一眼可见。

import { getBuiltinSearchEngine } from './defaults';
import { listSearchEngineIds } from './engines';
import { EXTRACT_SCRIPT_TEMPLATE } from './extract';
import {
  isBuiltinSearchEngineId,
  newCustomSearchEngineId,
  type BuiltinSearchEngineOverlay,
  type CustomSearchEngine,
  type SearchEngineDraft,
  type SearchEnginesConfig,
} from './types';

/**
 * 空白草稿：新建自定义引擎时用（id 此刻就定下，之后永不变）。脚本预填契约模板，
 * 用户看到的是一份能跑的起手代码而不是空框。传入当前配置以避开已占用的 id。
 */
function newSearchEngineDraft(config: SearchEnginesConfig): SearchEngineDraft {
  const taken = new Set(listSearchEngineIds(config));
  let id = newCustomSearchEngineId();
  while (taken.has(id)) id = newCustomSearchEngineId();
  return {
    id,
    kind: 'custom',
    name: '',
    urlTemplate: '',
    extract: EXTRACT_SCRIPT_TEMPLATE,
    when: '',
  };
}

/** 把内置引擎草稿恢复为默认值；自定义引擎原样返回。 */
function resetBuiltinSearchEngineDraft(draft: SearchEngineDraft): SearchEngineDraft {
  const def = getBuiltinSearchEngine(draft.id);
  if (!def) return draft;
  return {
    ...draft,
    name: def.getName(),
    urlTemplate: def.urlTemplate,
    extract: def.extract,
    when: def.getWhen?.() ?? '',
  };
}

/** 内置引擎的 overlay：只留与默认值不同的字段，全空则整条删掉。 */
function overlayFrom(
  draft: SearchEngineDraft,
  previous: BuiltinSearchEngineOverlay | undefined,
): BuiltinSearchEngineOverlay | undefined {
  const def = getBuiltinSearchEngine(draft.id);
  if (!def) return previous;
  const urlTemplate = draft.urlTemplate.trim();
  const extract = draft.extract.replace(/\s+$/, '');
  const when = draft.when.trim();
  const defaultWhen = def.getWhen?.() ?? '';
  const next: BuiltinSearchEngineOverlay = {
    // enabled 由列表上的开关维护，编辑页只是原样带过去。只保留 false——`enabled: true`
    // 与默认完全等价，留着就成了「看起来改过其实没改」的空壳。
    ...(previous?.enabled === false ? { enabled: false } : {}),
    ...(urlTemplate && urlTemplate !== def.urlTemplate ? { urlTemplate } : {}),
    ...(extract && extract !== def.extract ? { extract } : {}),
    ...(when !== defaultWhen ? { when } : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

/** 把一份草稿写回配置：内置引擎写 overlay，自定义引擎整条 upsert（新建则追加）。 */
function saveSearchEngineDraft(config: SearchEnginesConfig, draft: SearchEngineDraft): SearchEnginesConfig {
  if (isBuiltinSearchEngineId(draft.id)) {
    const builtin = { ...config.builtin };
    const overlay = overlayFrom(draft, builtin[draft.id]);
    if (overlay) builtin[draft.id] = overlay;
    else delete builtin[draft.id];
    return { ...config, builtin };
  }

  const when = draft.when.trim();
  const existing = config.custom.find((e) => e.id === draft.id);
  const next: CustomSearchEngine = {
    id: draft.id,
    name: draft.name.trim(),
    urlTemplate: draft.urlTemplate.trim(),
    extract: draft.extract.replace(/\s+$/, ''),
    ...(when ? { when } : {}),
    // enabled 由列表上的开关维护；省略即启用，故只有关掉状态需要落库。
    ...(existing?.enabled === false ? { enabled: false } : {}),
  };
  const custom = existing
    ? config.custom.map((e) => (e.id === draft.id ? next : e))
    : [...config.custom, next];
  return { ...config, custom };
}

/**
 * 启停一个引擎（内置写 overlay.enabled，自定义写自身字段）。
 * 启用是默认值，故重新开启时把 `enabled` 字段整个去掉而不是写 `true`；overlay 因此
 * 变空就连整条一起删。
 */
function setSearchEngineEnabled(config: SearchEnginesConfig, id: string, enabled: boolean): SearchEnginesConfig {
  if (isBuiltinSearchEngineId(id)) {
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
    custom: config.custom.map((e) => {
      if (e.id !== id) return e;
      if (!enabled) return { ...e, enabled: false };
      const { enabled: _wasEnabled, ...rest } = e;
      return rest;
    }),
  };
}

/** 把内置引擎的用户修改（地址 / 脚本 / 适用场景）全部丢掉，只保留启停状态。 */
function resetBuiltinSearchEngine(config: SearchEnginesConfig, id: string): SearchEnginesConfig {
  if (!isBuiltinSearchEngineId(id)) return config;
  const builtin = { ...config.builtin };
  if (builtin[id]?.enabled === false) builtin[id] = { enabled: false };
  else delete builtin[id];
  return { ...config, builtin };
}

/** 删除一个自定义引擎（内置引擎只能关，不能删）。顺序里的残留 id 一并清掉。 */
function deleteCustomSearchEngine(config: SearchEnginesConfig, id: string): SearchEnginesConfig {
  if (isBuiltinSearchEngineId(id)) return config;
  return {
    ...config,
    custom: config.custom.filter((e) => e.id !== id),
    ...(config.order ? { order: config.order.filter((o) => o !== id) } : {}),
  };
}

/**
 * 把一个引擎在回退顺序里前移 / 后移一格。落库的是**完整顺序**而不是相对位置，
 * 故此后新增引擎照旧补在末尾，不会因「部分顺序」产生歧义。已在两端时原样返回。
 */
function moveSearchEngine(config: SearchEnginesConfig, id: string, delta: -1 | 1): SearchEnginesConfig {
  const ids = listSearchEngineIds(config);
  const from = ids.indexOf(id);
  if (from < 0) return config;
  const to = from + delta;
  if (to < 0 || to >= ids.length) return config;
  const order = [...ids];
  [order[from], order[to]] = [order[to], order[from]];
  return { ...config, order };
}

export {
  newSearchEngineDraft,
  resetBuiltinSearchEngineDraft,
  saveSearchEngineDraft,
  setSearchEngineEnabled,
  resetBuiltinSearchEngine,
  deleteCustomSearchEngine,
  moveSearchEngine,
};

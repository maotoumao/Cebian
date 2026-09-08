// 「引擎」这个事物的纯逻辑：把配置读成生效引擎、构造搜索 URL、决定回退顺序、
// 判断某个 tab 是否还是我们的搜索页。背景（web_search 工具）与设置页共用。
//
// 与 edit-config.ts 分工：那边把用户的编辑**写**回配置，这边把配置**读**成生效引擎。

import { getBuiltinSearchEngine } from './defaults';
import {
  BUILTIN_SEARCH_ENGINE_IDS,
  QUERY_PLACEHOLDER,
  isBuiltinSearchEngineId,
  isSearchEngineId,
  type CustomSearchEngine,
  type SearchEnginesConfig,
} from './types';

/** 一条已合并默认值与用户覆盖层的引擎。 */
interface ResolvedSearchEngine {
  id: string;
  name: string;
  kind: 'builtin' | 'custom';
  enabled: boolean;
  urlTemplate: string;
  extract: string;
  when?: string;
  /** 内置引擎是否有除启停之外的用户修改（列表上标「已修改」、菜单里能「恢复默认」）。 */
  modified: boolean;
}

// ─── URL 模板 ───

type UrlTemplateProblem = 'missingPlaceholder' | 'invalidUrl';

/**
 * 校验搜索地址模板：必须是 http(s) 绝对地址且含 `{query}`。
 * 返回问题类型而不是布尔，让设置页能给出对应的提示文案。
 */
function validateUrlTemplate(template: string): UrlTemplateProblem | null {
  if (!template.includes(QUERY_PLACEHOLDER)) return 'missingPlaceholder';
  const host = searchEngineHost(template);
  return host ? null : 'invalidUrl';
}

/** 把搜索词填进模板：所有 `{query}` 都替换为 `encodeURIComponent(query)`。模板缺占位符时抛错。 */
function buildSearchUrl(template: string, query: string): string {
  if (!template.includes(QUERY_PLACEHOLDER)) {
    throw new Error(`Search URL template is missing the ${QUERY_PLACEHOLDER} placeholder: ${template}`);
  }
  return template.split(QUERY_PLACEHOLDER).join(encodeURIComponent(query));
}

/** 模板对应的 host（小写、去掉前缀 `www.`）；不是合法 http(s) 地址则 null。 */
function searchEngineHost(template: string): string | null {
  try {
    const url = new URL(template.split(QUERY_PLACEHOLDER).join('x'));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * 该 tab 的 URL 是否落在某个引擎的域上（本域或子域）。
 * 引擎会跳转到兄弟域（`www.bing.com` → `cn.bing.com`、Google → `consent.google.com`），
 * 严格相等会让复用的 tab 每次都被当成「用户挪走了」而重开一个。
 */
function isSearchEngineHost(tabUrl: string, engines: ResolvedSearchEngine[]): boolean {
  let host: string;
  try {
    const url = new URL(tabUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    host = url.hostname.toLowerCase();
  } catch {
    return false;
  }
  return engines.some((e) => {
    const base = searchEngineHost(e.urlTemplate);
    return base !== null && (host === base || host.endsWith(`.${base}`));
  });
}

// ─── 配置 → 生效引擎 ───

/**
 * 自定义引擎里 id 合法且不与内置冲突的那些。脏配置（手改备份包、旧版本、并发写）
 * 可能带来非法 id 或与内置重名的条目，在此就地丢弃，让整条链路只见到干净数据。
 */
function validCustomEngines(config: SearchEnginesConfig): CustomSearchEngine[] {
  const seen = new Set<string>();
  return config.custom.filter((e) => {
    if (!isSearchEngineId(e.id) || isBuiltinSearchEngineId(e.id) || seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

/**
 * 全部引擎 id，按回退顺序：`order` 里认得的 id 在前（按其顺序），其余按缺省顺序补在后面
 * ——内置在前（BUILTIN_SEARCH_ENGINE_IDS 的顺序），自定义按数组序。
 * `order` 里已不存在的 id 直接忽略，故删引擎 / 换设备都不会把顺序搞坏。
 */
function listSearchEngineIds(config: SearchEnginesConfig): string[] {
  const fallback = [
    ...BUILTIN_SEARCH_ENGINE_IDS,
    ...validCustomEngines(config).map((e) => e.id),
  ] as string[];
  if (!config.order) return fallback;
  const known = new Set(fallback);
  const seen = new Set<string>();
  const listed: string[] = [];
  for (const id of config.order) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    listed.push(id);
  }
  return [...listed, ...fallback.filter((id) => !seen.has(id))];
}

function resolveBuiltin(id: string, config: SearchEnginesConfig): ResolvedSearchEngine | undefined {
  const def = getBuiltinSearchEngine(id);
  if (!def) return undefined;
  const overlay = config.builtin[def.id];
  const defaultWhen = def.getWhen?.();
  const when = overlay?.when ?? defaultWhen;
  return {
    id: def.id,
    name: def.getName(),
    kind: 'builtin',
    enabled: overlay?.enabled !== false,
    urlTemplate: overlay?.urlTemplate ?? def.urlTemplate,
    extract: overlay?.extract ?? def.extract,
    ...(when ? { when } : {}),
    modified:
      overlay?.urlTemplate !== undefined ||
      overlay?.extract !== undefined ||
      overlay?.when !== undefined,
  };
}

function resolveCustom(engine: CustomSearchEngine): ResolvedSearchEngine {
  return {
    id: engine.id,
    name: engine.name,
    kind: 'custom',
    enabled: engine.enabled !== false,
    urlTemplate: engine.urlTemplate,
    extract: engine.extract,
    ...(engine.when ? { when: engine.when } : {}),
    modified: false,
  };
}

/** 按 id 取已解析引擎（不看启停——调用方自己决定要不要用）。 */
function findSearchEngine(config: SearchEnginesConfig, id: string): ResolvedSearchEngine | undefined {
  if (isBuiltinSearchEngineId(id)) return resolveBuiltin(id, config);
  const custom = validCustomEngines(config).find((e) => e.id === id);
  return custom ? resolveCustom(custom) : undefined;
}

/** 全部引擎，按回退顺序——设置页用（要能看见并管理被关掉的引擎）。 */
function listSearchEngines(config: SearchEnginesConfig): ResolvedSearchEngine[] {
  const out: ResolvedSearchEngine[] = [];
  for (const id of listSearchEngineIds(config)) {
    const engine = findSearchEngine(config, id);
    if (engine) out.push(engine);
  }
  return out;
}

/** 参与搜索的引擎，按回退顺序——`web_search` 工具用。 */
function enabledSearchEngines(config: SearchEnginesConfig): ResolvedSearchEngine[] {
  return listSearchEngines(config).filter((e) => e.enabled);
}

/**
 * 把模型点名的引擎提到最前，其余保持配置顺序。点名一个不存在 / 未启用的 id 是非法
 * 输入，抛错并列出可用 id，让模型下次能改对。
 */
function preferSearchEngine(engines: ResolvedSearchEngine[], preferredId?: string): ResolvedSearchEngine[] {
  if (!preferredId) return engines;
  const preferred = engines.find((e) => e.id === preferredId);
  if (!preferred) {
    const ids = engines.map((e) => e.id).join(', ') || '(none)';
    throw new Error(`Unknown search engine "${preferredId}". Enabled engines: ${ids}`);
  }
  return [preferred, ...engines.filter((e) => e !== preferred)];
}

export {
  validateUrlTemplate,
  buildSearchUrl,
  searchEngineHost,
  isSearchEngineHost,
  listSearchEngineIds,
  findSearchEngine,
  listSearchEngines,
  enabledSearchEngines,
  preferSearchEngine,
  type ResolvedSearchEngine,
};

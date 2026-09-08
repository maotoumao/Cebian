// 联网搜索引擎配置的形状（用户可配置层）与抽取契约。
//
// 一个引擎 = 名称 + 搜索地址模板（含 `{query}`）+ 一段在结果页里运行的 `extract` 脚本
// + 可选的「适用场景」提示。内置引擎的默认值在 defaults.ts；用户对内置项的修改存成
// 覆盖层，自定义引擎整条存数组，顺序另存 `order`——与划词动作配置同一套模型
//（lib/page-actions/types.ts），读法与合并语义都能照搬。

/**
 * 内置引擎 id 的单一真理源：类型由数组推导，守卫复用同一数组，defaults.ts 的注册表
 * 用 `satisfies Record<BuiltinSearchEngineId, …>` 保持穷尽。数组顺序即缺省的回退顺序。
 */
const BUILTIN_SEARCH_ENGINE_IDS = ['bing', 'brave', 'google', 'duckduckgo', 'baidu'] as const;

type BuiltinSearchEngineId = (typeof BUILTIN_SEARCH_ENGINE_IDS)[number];

function isBuiltinSearchEngineId(v: unknown): v is BuiltinSearchEngineId {
  return typeof v === 'string' && (BUILTIN_SEARCH_ENGINE_IDS as readonly string[]).includes(v);
}

/** 自定义引擎 id 的形态；与 `newCustomSearchEngineId` 是同一约定的两面，必须同步改。 */
const CUSTOM_SEARCH_ENGINE_ID_RE = /^custom-[a-z0-9]{8,}$/;

/** 生成一个自定义引擎 id。创建时调用一次，之后永不变（order / overlay 按它索引）。 */
function newCustomSearchEngineId(): string {
  return `custom-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * id 格式校验：只认内置 id 与 `custom-<hex>`。配置按 id 索引普通对象，`__proto__` /
 * `constructor` 这类原型键在这里就地挡住，比依赖每个查表点自己防御更可靠。
 */
function isSearchEngineId(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  return isBuiltinSearchEngineId(v) || CUSTOM_SEARCH_ENGINE_ID_RE.test(v);
}

/** 搜索地址模板里的搜索词占位符；构造 URL 时替换为 `encodeURIComponent(query)`。 */
const QUERY_PLACEHOLDER = '{query}';

// ─── 配置 ───

/** 用户自定义的搜索引擎。 */
interface CustomSearchEngine {
  /** `custom-<随机串>`，创建时生成后永不改。 */
  id: string;
  /** 显示名。用户原样输入，不走 i18n。 */
  name: string;
  /** 搜索地址模板，必须含 `{query}`。 */
  urlTemplate: string;
  /** 在结果页里运行的完整脚本：定义 `function extract({ document, query })`。 */
  extract: string;
  /** 什么时候优先用它（如「中文查询」）；写进工具说明给模型参考。缺省 = 无提示。 */
  when?: string;
  /** 是否参与搜索。缺省 = true（与内置引擎的覆盖层同语义，设置里共用一列开关）。 */
  enabled?: boolean;
}

/** 内置引擎的用户覆盖层。字段缺省即「用默认」，不写就是没改过。 */
interface BuiltinSearchEngineOverlay {
  /** 是否参与搜索。缺省 = true。 */
  enabled?: boolean;
  /** 覆盖搜索地址模板；缺省 = 用默认。 */
  urlTemplate?: string;
  /** 覆盖抽取脚本；缺省 = 用默认。 */
  extract?: string;
  /** 覆盖适用场景；缺省 = 用默认。 */
  when?: string;
}

/** 搜索引擎的全量配置。 */
interface SearchEnginesConfig {
  /** 内置引擎覆盖层，按内置 id 索引。 */
  builtin: Partial<Record<BuiltinSearchEngineId, BuiltinSearchEngineOverlay>>;
  /** 用户自定义引擎。 */
  custom: CustomSearchEngine[];
  /** 回退顺序（内置 + 自定义 id 混排）；缺省 / 未列出的按内置在前、自定义按数组序补在后。 */
  order?: string[];
}

/**
 * 编辑中的引擎（设置页表单的形状）。内置与自定义共用一份表单，`kind` 只决定写回配置时
 * 落到 overlay 还是 custom 数组。内置项与默认值相同的字段写回时会被省略。
 */
interface SearchEngineDraft {
  id: string;
  kind: 'builtin' | 'custom';
  name: string;
  urlTemplate: string;
  extract: string;
  when: string;
}

// ─── 抽取契约（脚本 ↔ 工具） ───

/**
 * 脚本对结果页的判定：
 * - `ok`：结果容器在，`results` 是抽到的条目（可以为空 = 引擎真的没结果）
 * - `empty`：结果容器还没出现（可能还在渲染，工具会短暂重试）
 * - `blocked`：明确识别到验证码 / 拦截页（工具不重试，直接换下一个引擎）
 */
type ExtractStatus = 'ok' | 'empty' | 'blocked';

interface SearchResultItem {
  title: string;
  url: string;
  snippet?: string;
}

interface ExtractResult {
  status: ExtractStatus;
  results: SearchResultItem[];
}

export {
  BUILTIN_SEARCH_ENGINE_IDS,
  QUERY_PLACEHOLDER,
  isBuiltinSearchEngineId,
  isSearchEngineId,
  newCustomSearchEngineId,
  type BuiltinSearchEngineId,
  type CustomSearchEngine,
  type BuiltinSearchEngineOverlay,
  type SearchEnginesConfig,
  type SearchEngineDraft,
  type ExtractStatus,
  type SearchResultItem,
  type ExtractResult,
};

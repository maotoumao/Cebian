import { storage } from '#imports';

// ─── Provider credential types ───

export interface ApiKeyCredential {
  authType: 'apiKey';
  apiKey: string;
  verified: boolean;
}

export interface OAuthCredential {
  authType: 'oauth';
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  verified: boolean;
  extra?: Record<string, unknown>;
}

export type ProviderCredential = ApiKeyCredential | OAuthCredential;

export type ProviderCredentials = Record<string, ProviderCredential>;

// ─── Model identity ───

/** 一个模型的轻量身份标识（provider key + modelId），可解析成 pi-ai 的运行时
 *  `Model`。既用于全局「新对话默认模型」存储项 `lastSelectedModel`，也用于会话行 /
 *  prompt 携带的「本次所用模型」。 */
export interface ModelIdentity {
  provider: string;
  modelId: string;
}

// ─── Custom providers (OpenAI-compatible) ───

export interface CustomModelDef {
  modelId: string;
  name: string;
  reasoning: boolean;
  /** 模型是否支持图片输入（多模态/VLM）。缺省视为 false（纯文本）。 */
  image?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface CustomProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  models: CustomModelDef[];
}

// ─── MCP servers ───

/**
 * Authentication strategy for an MCP server.
 * v1 only ships `none` and `bearer`. The discriminated union leaves room for
 * `oauth2` (using lib/oauth.ts + entrypoints/background/oauth-refresh.ts) and
 * `custom` without breaking existing records.
 */
export type MCPAuthConfig =
  | { type: 'none' }
  | { type: 'bearer'; token: string };

/**
 * Transport descriptor. v1 supports Streamable HTTP and SSE only —
 * stdio is intentionally excluded (Chrome extension cannot spawn processes).
 *
 * Names match the MCP spec / SDK class names (`StreamableHTTPClientTransport`,
 * `SSEClientTransport`) so users / docs / code share one vocabulary.
 */
export interface MCPTransportConfig {
  type: 'streamable-http' | 'sse';
  url: string;
  /** Static request headers. Dynamic auth tokens belong in `auth`, not here. */
  headers?: Record<string, string>;
}

/**
 * Persistent user-facing configuration for one MCP server.
 *
 * Runtime state (active connection, tool-list cache, rate-limiter counters,
 * circuit-breaker state) lives in background SW memory, NOT in this record.
 * Sensitive runtime tokens (e.g. OAuth refresh) will live in a separate
 * `mcpServerRuntime` storage item when we add OAuth.
 */
export interface MCPServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: MCPTransportConfig;
  auth: MCPAuthConfig;
  /** Schema version for forward-compatible migrations. */
  schemaVersion: 1;
  createdAt: number;
  updatedAt: number;
}

export const mcpServers = storage.defineItem<MCPServerConfig[]>(
  'local:mcpServers',
  { fallback: [] },
);

// ─── Thinking level ───

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high';

// ─── Storage items (WXT defineItem) ───

export const providerCredentials = storage.defineItem<ProviderCredentials>(
  'local:providerCredentials',
  { fallback: {} },
);

export const lastSelectedModel = storage.defineItem<ModelIdentity | null>(
  'local:activeModel',
  { fallback: null },
);

/** 上下文压缩（摘要）专用模型。`null` = 跟随对话主模型（默认）。配置一个更小更省
 *  的模型，可让后台压缩调用不必动用昂贵的主模型；解析失败时后台静默回退主模型。 */
export const compactionModel = storage.defineItem<ModelIdentity | null>(
  'local:compactionModel',
  { fallback: null },
);

export const customProviders = storage.defineItem<CustomProviderConfig[]>(
  'local:customProviders',
  { fallback: [] },
);

export const lastSelectedThinkingLevel = storage.defineItem<ThinkingLevel>(
  'local:thinkingLevel',
  { fallback: 'medium' },
);

export const themePreference = storage.defineItem<'dark' | 'light' | 'system'>(
  'local:theme',
  { fallback: 'system' },
);

export const userInstructions = storage.defineItem<string>(
  'local:userInstructions',
  { fallback: '' },
);

/** Width of the file-tree panel inside FileWorkspace (Prompts / Skills sections). */
export const settingsFilePanelWidth = storage.defineItem<number>(
  'local:settingsFilePanelWidth',
  { fallback: 280 },
);

/**
 * Remembers the last-visited Settings section so reopening /settings lands where the user left off.
 * Stores a relative section path such as 'prompts' | 'providers' | 'skills' | ...
 */
export const lastSettingsSection = storage.defineItem<string>(
  'local:lastSettingsSection',
  { fallback: 'providers' },
);

// ─── Update notice (in-app "new version available" dialog) ───

/**
 * 控制「发现新版本」弹窗的提醒频率与版本跳过状态。
 * - `skippedVersion`：用户点「跳过此版本」后记录的版本号，等于最新版时不再弹窗。
 * - `lastPromptedAt`：上次弹窗的时间戳，用于 24h 节流（关闭/立即更新后写入）。
 */
export interface UpdateNoticeState {
  skippedVersion: string | null;
  lastPromptedAt: number;
}

export const updateNoticeState = storage.defineItem<UpdateNoticeState>(
  'local:updateNoticeState',
  { fallback: { skippedVersion: null, lastPromptedAt: 0 } },
);

/**
 * 扩展刚更新到的版本号，待侧边栏下次打开时消费：背景 SW 在
 * `chrome.runtime.onInstalled`（reason=update）时写入当前版本，侧边栏启动后读取
 * 并打开对应版本的更新日志页，随即清空。`null` 表示无待展示更新。
 * 之所以经持久标记而非更新时直接开标签，是为了保证只在用户主动打开侧边栏后才弹页。
 */
export const pendingChangelogVersion = storage.defineItem<string | null>(
  'local:pendingChangelogVersion',
  { fallback: null },
);

// ─── WebDAV 备份连接配置 ───

/**
 * WebDAV 远程备份的连接配置。归入备份的「密钥信息」分类（含明文密码），
 * 因此默认不备份、备份时单独警告并可加密。`null` 表示尚未配置。
 */
export interface WebDavConfig {
  /** WebDAV 服务端点 URL。 */
  url: string;
  username: string;
  password: string;
  /** 远程目录路径，如 '/cebian'。 */
  directory: string;
}

export const webdavConfig = storage.defineItem<WebDavConfig | null>(
  'local:webdavConfig',
  { fallback: null },
);

// ─── 跨对话记忆（cross-conversation memory） ───

/** 记忆整理（organize）的「用户配置」。运行结果（上次时间）分到 memoryOrganizeState，
 *  避免后台写结果时读改写覆盖用户在设置页改的配置。`auto/intervalDays/minNewMemories`
 *  驱动自动整理调度（旧装机缺这些字段时由 `resolveOrganizeSettings` 补默认）。 */
export interface MemoryOrganizeSettings {
  /** 整理用模型；缺省回退当前活跃模型。 */
  model?: ModelIdentity;
  /** 自动整理开关。默认 false。 */
  auto: boolean;
  /** 自动整理最小间隔天数。默认 14。 */
  intervalDays: number;
  /** 距上次成功整理、新增/改动记忆达到此数才自动跑。默认 30。 */
  minNewMemories: number;
}

/** 记忆整理的「运行结果态」（派生、非用户配置）。只有 organize manager 写它，故读改写无竞态；
 *  备份无意义（exclude）。设置页响应式读取以展示「上次整理时间」。 */
export interface MemoryOrganizeState {
  /** 上次「成功」整理的时间（冲突/失败跳过不更新）。 */
  lastRunAt?: number;
  /** 上次「尝试」整理的时间（含冲突/失败跳过；退避调度用，避免反复烧 token）。 */
  lastAttemptAt?: number;
}

/**
 * 跨对话记忆系统的持久设置。`enabled` 是主开关；`organize` 是整理子结构。
 *
 * `organize` 故意可选：早期装机只存了 `{ enabled }`，WXT 的 fallback 仅在 key
 * 整体缺失时生效、不会给「已存在但缺字段」的旧值补子结构（实测 version 迁移在旧值
 * 无 version meta 时也不触发）。故读取整理设置一律走 `resolveOrganizeSettings`，由它
 * 补默认值——这是唯一可靠且可测的回填点。
 */
export interface MemorySettings {
  /** 记忆系统总开关。关闭时不注入记忆提示/索引、整理调度不运行；文件工具层不做硬拦截。默认 false（隐私优先）。 */
  enabled: boolean;
  /** 整理设置（旧装机可能缺；用 `resolveOrganizeSettings` 取规范值）。 */
  organize?: MemoryOrganizeSettings;
}

/** organize 子结构的默认值（新装机 fallback + 旧装机回填共用单一真理源）。默认偏保守：
 *  自动关、间隔 14 天、攒够 30 条新记忆才自动跑——基本不打扰、不意外烧 token。 */
const DEFAULT_ORGANIZE: MemoryOrganizeSettings = {
  auto: false,
  intervalDays: 14,
  minNewMemories: 30,
};

/** 取规范的整理设置：补齐旧装机缺失的 organize 子结构。所有整理逻辑读设置的唯一入口。 */
export function resolveOrganizeSettings(s: MemorySettings): MemoryOrganizeSettings {
  return { ...DEFAULT_ORGANIZE, ...s.organize };
}

export const memorySettings = storage.defineItem<MemorySettings>(
  'local:memorySettings',
  { fallback: { enabled: false, organize: { ...DEFAULT_ORGANIZE } } },
);

/** 整理运行结果态（派生）。只有 organize manager 写；fallback 空对象。 */
export const memoryOrganizeState = storage.defineItem<MemoryOrganizeState>(
  'local:memoryOrganizeState',
  { fallback: {} },
);

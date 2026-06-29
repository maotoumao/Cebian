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

/**
 * 跨对话记忆系统的持久设置。Phase 1 仅 `enabled` 主开关；整理（organize）相关
 * 字段在 Phase 2 扩展（WXT 存储项有默认值兜底，加字段向后兼容）。
 */
export interface MemorySettings {
  /** 记忆系统总开关。关闭时不注入记忆提示/索引、后续整理调度不运行；文件工具层不做硬拦截。默认 false（隐私优先）。 */
  enabled: boolean;
}

export const memorySettings = storage.defineItem<MemorySettings>(
  'local:memorySettings',
  { fallback: { enabled: false } },
);

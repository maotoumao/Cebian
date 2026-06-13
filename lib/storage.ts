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

// ─── Active model ───

export interface ActiveModel {
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

export const activeModel = storage.defineItem<ActiveModel | null>(
  'local:activeModel',
  { fallback: null },
);

export const customProviders = storage.defineItem<CustomProviderConfig[]>(
  'local:customProviders',
  { fallback: [] },
);

export const thinkingLevel = storage.defineItem<ThinkingLevel>(
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

export const maxRounds = storage.defineItem<number>(
  'local:maxRounds',
  { fallback: 200 },
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

import { mcpServers, type MCPServerConfig } from '@/lib/persistence/storage';
import {
  MCPClient,
  type MCPResourceContents,
  type MCPTool,
  type MCPToolResult,
} from './client';
import { DEFAULT_THROTTLE, ServerThrottle, type ThrottleAcquire } from './throttle';
import type { BreakerError, BreakerState } from './circuit-breaker';

/**
 * Process-level singleton that owns one `MCPClient` + `ServerThrottle` per
 * configured MCP server.
 *
 * Lives in the background service worker. State (connections, tool cache,
 * throttle counters) is in-memory and is rebuilt on SW restart.
 */

const TOOL_CACHE_TTL_MS = 10 * 60 * 1000;
/** 后台试连失败后，至少隔这么久才再试（与熔断冷却期一致）。 */
const RETRY_AFTER_FAILURE_MS = DEFAULT_THROTTLE.cooldownMs;

interface ServerEntry {
  config: MCPServerConfig;
  client: MCPClient;
  throttle: ServerThrottle;
  toolCache?: { tools: MCPTool[]; fetchedAt: number };
  connecting?: Promise<void>;
  refreshingTools?: Promise<MCPTool[]>;
}

export class ThrottleError extends Error {
  constructor(public readonly rejection: Exclude<ThrottleAcquire, { ok: true }>) {
    super(`MCP throttled: ${rejection.reason} (retryAfter=${rejection.retryAfterMs}ms)`);
    this.name = 'ThrottleError';
  }
}

export interface ServerStatus {
  connected: boolean;
  breaker: BreakerState;
  /** 最近一次连接 / 请求失败的原因，比最近一次成功更新；成功后清空。 */
  lastError?: BreakerError;
}

export interface ServerToolsResult {
  server: MCPServerConfig;
  tools: MCPTool[];
  error?: unknown;
}

class MCPManager {
  private entries = new Map<string, ServerEntry>();
  private unwatch?: () => void;
  private initPromise?: Promise<void>;
  /** Fired AFTER reconcile mutates `entries`, so subscribers see fresh state. */
  private listeners = new Set<() => void>();
  /** 每次连接前要等的外部前置条件，见 `setConnectGate`。 */
  private connectGate?: () => Promise<void>;

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const configs = await mcpServers.getValue();
        for (const c of configs) this.upsert(c);
        this.unwatch = mcpServers.watch((next) => {
          void (async () => {
            await this.reconcile(next ?? []);
            this.notify();
          })();
        });
      })().catch((err) => {
        // Don't cache a rejected init — next caller should be able to retry,
        // otherwise a transient storage failure bricks all session creation
        // until the service worker restarts.
        this.initPromise = undefined;
        throw err;
      });
    }
    return this.initPromise;
  }

  /**
   * Subscribe to MCP config changes. Callbacks fire AFTER `entries` has been
   * reconciled, so calls into `getEnabledServers()` / `getAllTools()` from the
   * callback will see the new state. Returns an unsubscribe function.
   */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (err) {
        console.warn('[mcp] subscriber threw:', err);
      }
    }
  }

  /**
   * 设置每次连接前要等待的前置条件（只设一次，后设的覆盖先设的）。后台用它等去掉 Origin 头的
   * 网络规则按最新配置装好：新增 / 修改服务器时会话会立刻刷新工具并连接，若抢在规则生效前
   * 发出，校验 Origin 的服务器就会拒绝（#81）。gate 不应 reject，否则连接按失败处理。
   */
  setConnectGate(gate: () => Promise<void>): void {
    this.connectGate = gate;
  }

  async getEnabledServers(): Promise<MCPServerConfig[]> {
    await this.init();
    return Array.from(this.entries.values())
      .filter((e) => e.config.enabled)
      .map((e) => e.config);
  }

  async getStatus(serverId: string): Promise<ServerStatus | undefined> {
    await this.init();
    const entry = this.entries.get(serverId);
    if (!entry) return undefined;
    const lastError = entry.throttle.getLastError();
    return {
      connected: entry.client.isConnected(),
      breaker: entry.throttle.getBreakerState(),
      ...(lastError ? { lastError } : {}),
    };
  }

  /**
   * 在后台试连一个启用但未连上的服务器，让设置页不必等用户开会话就能看到连接结果。
   * 从没失败过（刚添加 / 改过配置 / SW 刚重启）就立即试；失败过则等冷却期过了再试，
   * 避免设置页每次轮询都去撞一个连不上的服务器。结果记在熔断器上，由 `getStatus` 读出；
   * 本方法自身不抛错。
   */
  async connectIfIdle(serverId: string): Promise<void> {
    try {
      await this.init();
      const entry = this.entries.get(serverId);
      if (!entry || !entry.config.enabled || entry.client.isConnected()) return;
      const lastError = entry.throttle.getLastError();
      if (lastError && Date.now() - lastError.at < RETRY_AFTER_FAILURE_MS) return;
      await this.getTools(serverId);
    } catch {
      // 失败已由熔断器记下（getStatus 会读出），这里不再处理
    }
  }

  async getTools(serverId: string): Promise<MCPTool[]> {
    await this.init();
    const entry = this.entries.get(serverId);
    if (!entry) throw new Error(`MCP server not registered: ${serverId}`);
    if (!entry.config.enabled) throw new Error(`MCP server disabled: ${entry.config.name}`);

    const now = Date.now();
    if (entry.toolCache && now - entry.toolCache.fetchedAt < TOOL_CACHE_TTL_MS) {
      return entry.toolCache.tools;
    }
    if (entry.refreshingTools) return entry.refreshingTools;

    const refreshing = this.refreshTools(entry).finally(() => {
      // 期间配置被改过时 upsert 已换掉这个字段，别把新一轮的进行中标记清掉
      if (entry.refreshingTools === refreshing) entry.refreshingTools = undefined;
    });
    entry.refreshingTools = refreshing;
    return refreshing;
  }

  /** Fetch tools for all enabled servers, isolating per-server errors. */
  async getAllTools(): Promise<ServerToolsResult[]> {
    const servers = await this.getEnabledServers();
    const results = await Promise.all(servers.map(async (server) => {
      try {
        const tools = await this.getTools(server.id);
        return { server, tools };
      } catch (error) {
        return { server, tools: [], error };
      }
    }));
    return results;
  }

  async callTool(
    serverId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<MCPToolResult> {
    await this.init();
    const entry = this.entries.get(serverId);
    if (!entry) throw new Error(`MCP server not registered: ${serverId}`);
    if (!entry.config.enabled) throw new Error(`MCP server disabled: ${entry.config.name}`);

    const { client, throttle } = await this.connectedRefs(entry);

    const acquired = throttle.acquire();
    if (!acquired.ok) throw new ThrottleError(acquired);

    try {
      const result = await client.callTool(name, args);
      throttle.recordSuccess();
      return result;
    } catch (err) {
      throttle.recordFailure(err);
      throw err;
    }
  }

  /**
   * Read an MCP resource (typically a `ui://` UI resource for MCP Apps).
   *
   * Lazily connects the server if needed — callers (e.g. the sidepanel
   * re-opening an old chat) shouldn't have to know whether the SW just
   * woke up. Mirrors `callTool`'s throttle pattern: when the server is
   * cold this consumes two throttle slots (one for the connect, one for
   * the read), which is the deliberate cost of treating reconnect as a
   * regular touch.
   */
  async readResource(serverId: string, uri: string): Promise<MCPResourceContents> {
    await this.init();
    const entry = this.entries.get(serverId);
    if (!entry) throw new Error(`MCP server not registered: ${serverId}`);
    if (!entry.config.enabled) throw new Error(`MCP server disabled: ${entry.config.name}`);

    const { client, throttle } = await this.connectedRefs(entry);

    const acquired = throttle.acquire();
    if (!acquired.ok) throw new ThrottleError(acquired);

    try {
      const resource = await client.readResource(uri);
      throttle.recordSuccess();
      return resource;
    } catch (err) {
      throttle.recordFailure(err);
      throw err;
    }
  }

  async closeAll(): Promise<void> {
    this.unwatch?.();
    this.unwatch = undefined;
    this.initPromise = undefined;
    const tasks = Array.from(this.entries.values()).map((e) => this.closeEntry(e));
    this.entries.clear();
    await Promise.allSettled(tasks);
  }

  // ─── internals ───

  private upsert(config: MCPServerConfig): void {
    const existing = this.entries.get(config.id);
    if (!existing) {
      this.entries.set(config.id, {
        config,
        client: new MCPClient(config),
        throttle: new ServerThrottle(),
      });
      return;
    }
    const enabledChanged = existing.config.enabled !== config.enabled;
    const material = this.materialChange(existing.config, config);
    if (material || enabledChanged) {
      // Material change OR any enabled flip: drop the connection + cache so
      // the next discover/use reconnects with current config and fetches
      // fresh tools. Critical for "enable a server" → tools appear instantly.
      void this.closeEntry(existing);
      existing.client = new MCPClient(config);
      existing.throttle = new ServerThrottle();
      existing.toolCache = undefined;
      existing.connecting = undefined;
      existing.refreshingTools = undefined;
    }
    existing.config = config;
  }

  private async reconcile(next: MCPServerConfig[]): Promise<void> {
    const nextIds = new Set(next.map((c) => c.id));
    for (const [id, entry] of this.entries) {
      if (!nextIds.has(id)) {
        this.entries.delete(id);
        void this.closeEntry(entry);
      }
    }
    for (const c of next) this.upsert(c);
  }

  private materialChange(a: MCPServerConfig, b: MCPServerConfig): boolean {
    if (a.transport.type !== b.transport.type) return true;
    if (a.transport.url !== b.transport.url) return true;
    if (!sameStringMap(a.transport.headers, b.transport.headers)) return true;
    if (a.auth.type !== b.auth.type) return true;
    if (a.auth.type === 'bearer' && b.auth.type === 'bearer' && a.auth.token !== b.auth.token) return true;
    return false;
  }

  private async ensureConnected(entry: ServerEntry): Promise<void> {
    if (entry.client.isConnected()) return;
    if (entry.connecting) return entry.connecting;

    const client = entry.client;
    const throttle = entry.throttle;

    const acquired = throttle.acquire();
    if (!acquired.ok) throw new ThrottleError(acquired);

    const connecting = (async () => {
      try {
        await this.connectGate?.();
        // 等 gate 期间服务器可能被禁用 / 删除 / 改配置：旧 client 不能再用旧地址和旧凭据发请求
        if (this.isStale(entry, client)) throw staleEntryError(entry);
        await client.connect();
        throttle.recordSuccess();
      } catch (err) {
        throttle.recordFailure(err);
        throw err;
      }
    })().finally(() => {
      if (entry.connecting === connecting) entry.connecting = undefined;
    });
    entry.connecting = connecting;
    return connecting;
  }

  /**
   * 连上服务器，返回连接所用的 client / throttle。引用在连接**之前**取：连接期间配置被改，
   * upsert 会换上新的、尚未连接的 client 和 throttle，这时继续用 `entry.client` 会在新
   * throttle 上记一条假的「not connected」失败，设置页随之显示错误、推迟重试。
   *
   * 连接期间服务器被改配置或删除时，upsert / reconcile 的 close 对还没连上的 client 是空操作，
   * 这里连上之后要自己关掉它，否则旧连接（含 Streamable HTTP 的长连 SSE 流）会一直挂到 SW 重启。
   */
  private async connectedRefs(entry: ServerEntry): Promise<{ client: MCPClient; throttle: ServerThrottle }> {
    const { client, throttle } = entry;
    await this.ensureConnected(entry);
    if (this.isStale(entry, client)) {
      void client.close().catch(() => {});
      throw staleEntryError(entry);
    }
    return { client, throttle };
  }

  /** client 已被 upsert 换掉（改配置 / 启停），或整个服务器已从注册表删除。 */
  private isStale(entry: ServerEntry, client: MCPClient): boolean {
    return entry.client !== client || this.entries.get(entry.config.id) !== entry;
  }

  private async refreshTools(entry: ServerEntry): Promise<MCPTool[]> {
    const { client, throttle } = await this.connectedRefs(entry);

    const acquired = throttle.acquire();
    if (!acquired.ok) throw new ThrottleError(acquired);

    try {
      const tools = await client.listTools();
      throttle.recordSuccess();
      // 期间配置被改过（upsert 换了 client）时，这份是旧服务器的工具，不能写进新配置的缓存
      if (entry.client === client) entry.toolCache = { tools, fetchedAt: Date.now() };
      return tools;
    } catch (err) {
      throttle.recordFailure(err);
      throw err;
    }
  }

  private async closeEntry(entry: ServerEntry): Promise<void> {
    try {
      await entry.client.close();
    } catch {
      // best-effort cleanup; errors during close are non-actionable
    }
  }
}

function staleEntryError(entry: ServerEntry): Error {
  return new Error(`MCP server "${entry.config.name}" was reconfigured or removed while connecting`);
}

function sameStringMap(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
): boolean {
  const ak = a ? Object.keys(a) : [];
  const bk = b ? Object.keys(b) : [];
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (a![k] !== b?.[k]) return false;
  }
  return true;
}

let singleton: MCPManager | undefined;

export function getMCPManager(): MCPManager {
  if (!singleton) singleton = new MCPManager();
  return singleton;
}

/** Test/reset hook. Not for production use. */
export async function __resetMCPManager(): Promise<void> {
  if (singleton) await singleton.closeAll();
  singleton = undefined;
}
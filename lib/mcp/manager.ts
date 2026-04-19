import { mcpServers, type MCPServerConfig } from '@/lib/storage';
import { MCPClient, type MCPTool, type MCPToolResult } from './client';
import { ServerThrottle, type ThrottleAcquire } from './throttle';
import type { BreakerState } from './circuit-breaker';

/**
 * Process-level singleton that owns one `MCPClient` + `ServerThrottle` per
 * configured MCP server.
 *
 * Lives in the background service worker. State (connections, tool cache,
 * throttle counters) is in-memory and is rebuilt on SW restart.
 */

const TOOL_CACHE_TTL_MS = 10 * 60 * 1000;

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

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const configs = await mcpServers.getValue();
        for (const c of configs) this.upsert(c);
        this.unwatch = mcpServers.watch((next) => {
          void this.reconcile(next ?? []);
        });
      })();
    }
    return this.initPromise;
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
    return {
      connected: entry.client.isConnected(),
      breaker: entry.throttle.getBreakerState(),
    };
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

    entry.refreshingTools = this.refreshTools(entry).finally(() => {
      entry.refreshingTools = undefined;
    });
    return entry.refreshingTools;
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

    await this.ensureConnected(entry);

    // Capture refs so a mid-call reconcile that swaps client/throttle
    // doesn't cross-record on a fresh throttle that never saw acquire.
    const client = entry.client;
    const throttle = entry.throttle;

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
    const enabledFalling = existing.config.enabled && !config.enabled;
    const material = this.materialChange(existing.config, config);
    if (material || enabledFalling) {
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

    entry.connecting = (async () => {
      try {
        await client.connect();
        throttle.recordSuccess();
      } catch (err) {
        throttle.recordFailure(err);
        throw err;
      }
    })().finally(() => {
      entry.connecting = undefined;
    });
    return entry.connecting;
  }

  private async refreshTools(entry: ServerEntry): Promise<MCPTool[]> {
    await this.ensureConnected(entry);

    const client = entry.client;
    const throttle = entry.throttle;

    const acquired = throttle.acquire();
    if (!acquired.ok) throw new ThrottleError(acquired);

    try {
      const tools = await client.listTools();
      throttle.recordSuccess();
      entry.toolCache = { tools, fetchedAt: Date.now() };
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
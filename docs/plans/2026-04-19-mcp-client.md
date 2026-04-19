# MCP Client Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users connect Cebian to MCP servers (Streamable HTTP transport only — Service Worker has no stdio) and expose their `tools/list` to the agent under namespaced names. Resources and Prompts are deliberately deferred.

**Architecture:** A new background-side `mcpManager` singleton holds lazy `McpClient` connections. `tools/list` is cached for 30 minutes (or invalidated on `tools/list_changed`). `tools/call` invocations are routed through the manager with a per-server token-bucket rate limiter, exponential-backoff reconnect, and a 5-minute circuit breaker after repeated failure. Discovered tools are wrapped as `AgentTool<any>` instances with name prefix `mcp__<serverId>__<toolName>` and merged into `createSessionTools()`. Configuration UI mirrors the existing `ProviderManagerDialog` pattern (form-driven UI with an "Edit as JSON" escape hatch).

**Tech Stack:** `@modelcontextprotocol/sdk` (browser-friendly Streamable HTTP transport), Typebox for schema validation, WXT storage, React shadcn dialog/form.

---

## Scope

**In scope (v1):**
- Streamable HTTP / SSE transport only.
- MCP **Tools** primitive (discovery + invocation).
- Per-server config: name, URL, headers (incl. Bearer auth), enabled flag, optional name prefix.
- Lazy connect, 30-min `tools/list` cache, idle disconnect after 60 s.
- Rate limiting (token bucket: 10 burst / 1 sustained req/s), 5 retries with backoff before circuit opens, 5-min cool-down.
- Settings UI: list / add / edit / delete / test-connect / enable-disable.
- "Edit as JSON" escape hatch using existing CodeMirror.
- Per-session tool-prefix collision protection.

**Out of scope (deferred):**
- Resources primitive (needs `@`-mention UI).
- Prompts primitive (needs slash-command extension).
- OAuth / dynamic auth flows (manual Bearer token only for now).
- stdio transport (would require an external proxy — out of extension scope).
- ChatInput "disable specific MCP server's tools per turn" toggle (mentioned in discussion — defer to v2).

---

## File Structure

### New files
- `lib/mcp/types.ts` — config types, runtime status types.
- `lib/mcp/storage.ts` — `mcpServers` storage item (`CebianMcpServerConfig[]`).
- `lib/mcp/client.ts` — thin wrapper around `@modelcontextprotocol/sdk` Streamable HTTP client.
- `lib/mcp/rate-limiter.ts` — token bucket utility.
- `lib/mcp/circuit-breaker.ts` — circuit breaker state machine.
- `entrypoints/background/mcp-manager.ts` — singleton orchestrating connections, caches, breakers, broadcasts status changes.
- `lib/mcp/tool-adapter.ts` — `mcpToolToAgentTool(serverId, toolDecl, manager) → AgentTool<any>`.
- `components/settings/sections/McpSection.tsx` — list view.
- `components/settings/mcp/McpServerForm.tsx` — add/edit dialog form.
- `components/settings/mcp/McpJsonEditor.tsx` — bulk JSON editor.

### Modified files
- `package.json` — add `@modelcontextprotocol/sdk` dependency.
- `lib/tools/index.ts` — `createSessionTools(sessionId)` accepts a `mcpTools: AgentTool[]` parameter; merge in.
- `entrypoints/background/agent-manager.ts` — fetches MCP tools from `mcpManager` lazily before `prompt()`.
- `lib/protocol.ts` — new `mcp_status` server message + `mcp_test` / `mcp_reset` client messages.
- `components/settings/SectionNav.tsx` — add MCP section.
- `locales/en.yml`, `zh_CN.yml`, `zh_TW.yml` — `settings.mcp.*` keys.

---

## Task 1: Dependency + Storage + Types

**Files:**
- Modify: `package.json`
- Create: `lib/mcp/types.ts`, `lib/mcp/storage.ts`

- [ ] **Step 1: Add SDK**

```bash
pnpm add @modelcontextprotocol/sdk
```

- [ ] **Step 2: Define config types**

```ts
// lib/mcp/types.ts
export interface CebianMcpServerConfig {
  id: string;                        // ulid; generated on add
  name: string;                      // user-facing label, must be unique
  url: string;                       // https://… or http://localhost…
  enabled: boolean;
  /** Optional override; default `mcp__<sanitized-name>__`. */
  toolPrefix?: string;
  auth?:
    | { kind: 'none' }
    | { kind: 'bearer'; token: string }
    | { kind: 'header'; entries: Array<{ key: string; value: string }> };
  /** Free-form description shown in UI; not sent to agent. */
  description?: string;
}

export type McpServerStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; toolCount: number; connectedAt: number }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'circuit_open'; openedAt: number; retryAt: number; lastError: string }
  | { kind: 'error'; message: string };

export interface McpServerSnapshot {
  config: CebianMcpServerConfig;
  status: McpServerStatus;
}
```

- [ ] **Step 3: Storage**

```ts
// lib/mcp/storage.ts
import { storage } from '#imports';
import type { CebianMcpServerConfig } from './types';

export const mcpServers = storage.defineItem<CebianMcpServerConfig[]>(
  'local:mcpServers',
  { fallback: [] },
);
```

- [ ] **Step 4: Commit** — `feat(mcp): config types and storage`.

---

## Task 2: Rate Limiter + Circuit Breaker

**Files:**
- Create: `lib/mcp/rate-limiter.ts`, `lib/mcp/circuit-breaker.ts`

- [ ] **Step 1: Token-bucket rate limiter**

```ts
// lib/mcp/rate-limiter.ts
export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();
  constructor(
    private readonly capacity: number,           // burst (default 10)
    private readonly refillPerSec: number,       // sustained (default 1)
  ) {
    this.tokens = capacity;
  }
  /** Wait until a token is available, then consume one. */
  async take(signal?: AbortSignal): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      const waitMs = Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
      await sleep(waitMs, signal);
    }
  }
  private refill() {
    const now = Date.now();
    const dt = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerSec);
    this.lastRefill = now;
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
  });
}
```

- [ ] **Step 2: Circuit breaker**

```ts
// lib/mcp/circuit-breaker.ts
export class CircuitBreaker {
  private failureCount = 0;
  private openedAt = 0;
  constructor(
    private readonly threshold = 5,       // consecutive failures
    private readonly cooldownMs = 5 * 60_000,
  ) {}
  isOpen(): boolean {
    if (!this.openedAt) return false;
    if (Date.now() - this.openedAt >= this.cooldownMs) { this.reset(); return false; }
    return true;
  }
  recordSuccess() { this.failureCount = 0; this.openedAt = 0; }
  recordFailure() {
    this.failureCount += 1;
    if (this.failureCount >= this.threshold) this.openedAt = Date.now();
  }
  reset() { this.failureCount = 0; this.openedAt = 0; }
  retryAt(): number { return this.openedAt + this.cooldownMs; }
}
```

- [ ] **Step 3: Commit** — `feat(mcp): rate limiter and circuit breaker`.

---

## Task 3: MCP Client Wrapper

**Files:**
- Create: `lib/mcp/client.ts`

- [ ] **Step 1: Thin wrapper**

```ts
// lib/mcp/client.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CebianMcpServerConfig } from './types';

export interface McpClientHandle {
  client: Client;
  transport: StreamableHTTPClientTransport;
  close: () => Promise<void>;
}

const USER_AGENT = `Cebian-MCP-Client/${browser.runtime.getManifest().version}`;

export async function connectMcp(cfg: CebianMcpServerConfig, signal?: AbortSignal): Promise<McpClientHandle> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  if (cfg.auth?.kind === 'bearer') headers.Authorization = `Bearer ${cfg.auth.token}`;
  if (cfg.auth?.kind === 'header') for (const e of cfg.auth.entries) headers[e.key] = e.value;

  const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
    requestInit: { headers, signal },
  });
  const client = new Client({ name: 'cebian', version: browser.runtime.getManifest().version }, { capabilities: {} });
  await client.connect(transport);
  return {
    client, transport,
    close: async () => { try { await client.close(); } catch { /* ignore */ } },
  };
}
```

Implementer notes:
- Confirm exact import paths against the installed SDK version (the SDK's transport modules sometimes move); update accordingly.
- Pass `signal` through so reconnect cancellation works.

- [ ] **Step 2: Commit** — `feat(mcp): client wrapper`.

---

## Task 4: MCP Manager (background singleton)

**Files:**
- Create: `entrypoints/background/mcp-manager.ts`
- Create: `lib/mcp/tool-adapter.ts`

This is the load-bearing module. Below is a structural sketch — each behavior gets its own step.

- [ ] **Step 1: Skeleton + types**

```ts
// entrypoints/background/mcp-manager.ts
interface ManagedServer {
  config: CebianMcpServerConfig;
  handle?: McpClientHandle;
  toolsCache?: { tools: McpToolDecl[]; expiresAt: number };
  bucket: TokenBucket;
  breaker: CircuitBreaker;
  status: McpServerStatus;
  idleTimer?: number;
  inflight: Map<string, Promise<unknown>>; // for list_* dedup
}

const TOOLS_CACHE_TTL_MS = 30 * 60_000;
const IDLE_DISCONNECT_MS = 60_000;
```

- [ ] **Step 2: Lazy connect + idle disconnect**

```ts
private async ensureConnected(srv: ManagedServer): Promise<McpClientHandle> {
  if (srv.handle) { this.touchIdle(srv); return srv.handle; }
  if (srv.breaker.isOpen()) throw new Error('Circuit open');
  this.setStatus(srv, { kind: 'connecting' });
  try {
    srv.handle = await connectMcp(srv.config);
    this.setStatus(srv, { kind: 'connected', toolCount: srv.toolsCache?.tools.length ?? 0, connectedAt: Date.now() });
    srv.breaker.recordSuccess();
    this.touchIdle(srv);
    // Subscribe to list_changed to invalidate cache
    srv.handle.client.setNotificationHandler('notifications/tools/list_changed', () => {
      srv.toolsCache = undefined;
    });
    return srv.handle;
  } catch (err) {
    srv.breaker.recordFailure();
    this.setStatus(srv, srv.breaker.isOpen()
      ? { kind: 'circuit_open', openedAt: Date.now(), retryAt: srv.breaker.retryAt(), lastError: String(err) }
      : { kind: 'error', message: String(err) });
    throw err;
  }
}

private touchIdle(srv: ManagedServer) {
  if (srv.idleTimer) clearTimeout(srv.idleTimer);
  srv.idleTimer = setTimeout(() => this.disconnect(srv), IDLE_DISCONNECT_MS) as unknown as number;
}
```

- [ ] **Step 3: `listTools` with cache + dedup**

```ts
async listTools(serverId: string): Promise<McpToolDecl[]> {
  const srv = this.servers.get(serverId);
  if (!srv || !srv.config.enabled) return [];
  if (srv.toolsCache && srv.toolsCache.expiresAt > Date.now()) return srv.toolsCache.tools;

  const key = 'tools/list';
  const inflight = srv.inflight.get(key);
  if (inflight) return inflight as Promise<McpToolDecl[]>;

  const p = (async () => {
    await srv.bucket.take();
    const handle = await this.ensureConnected(srv);
    const res = await handle.client.listTools();
    srv.toolsCache = { tools: res.tools as McpToolDecl[], expiresAt: Date.now() + TOOLS_CACHE_TTL_MS };
    this.setStatus(srv, { kind: 'connected', toolCount: res.tools.length, connectedAt: srv.handle ? Date.now() : 0 });
    return srv.toolsCache.tools;
  })();
  srv.inflight.set(key, p);
  try { return await p; } finally { srv.inflight.delete(key); }
}
```

- [ ] **Step 4: `callTool` with rate limit + retry-after**

```ts
async callTool(serverId: string, toolName: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
  const srv = this.servers.get(serverId);
  if (!srv) throw new Error(`Unknown MCP server ${serverId}`);
  if (srv.breaker.isOpen()) throw new Error('Server in cooldown');

  await srv.bucket.take(signal);
  const handle = await this.ensureConnected(srv);
  try {
    const out = await handle.client.callTool({ name: toolName, arguments: args as any });
    srv.breaker.recordSuccess();
    this.touchIdle(srv);
    return out;
  } catch (err) {
    srv.breaker.recordFailure();
    // Honor Retry-After if present (StreamableHTTPClientTransport surfaces error.response sometimes)
    const retryAfter = extractRetryAfterMs(err);
    if (retryAfter) this.setStatus(srv, { kind: 'rate_limited', retryAfterMs: retryAfter });
    throw err;
  }
}
```

- [ ] **Step 5: Status broadcast**

When status changes, broadcast `{ type: 'mcp_status', servers: McpServerSnapshot[] }` so settings UI can react in real time.

- [ ] **Step 6: Tool adapter**

```ts
// lib/mcp/tool-adapter.ts
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';

export function mcpToolToAgentTool(
  serverId: string, toolDecl: McpToolDecl, manager: McpManager, prefix: string,
): AgentTool<any> {
  return {
    name: `${prefix}${toolDecl.name}`,
    label: toolDecl.title ?? toolDecl.name,
    description: toolDecl.description ?? '',
    // MCP exposes JSON Schema; pi-agent-core accepts Typebox-shaped schemas.
    // Easiest path: pass the JSON schema through Type.Strict().
    parameters: toolDecl.inputSchema as any,
    async execute(_id, args, signal): Promise<AgentToolResult<unknown>> {
      try {
        const out = await manager.callTool(serverId, toolDecl.name, args, signal ?? undefined);
        return {
          content: extractContent(out),
          details: out,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `MCP error: ${(err as Error).message}` }],
          details: { status: 'error' },
        };
      }
    },
  };
}
```

Implementer notes:
- pi-agent-core's `parameters` field expects a Typebox schema or a JSON-Schema-shaped object — verify which by reading `node_modules/@mariozechner/pi-agent-core` exports before relying on the cast.
- `extractContent` pulls `result.content` (MCP returns array of `{type:'text'|'image', ...}` blocks).

- [ ] **Step 7: Manager bootstrap**

In `entrypoints/background/index.ts`, after creating `agentManager`:
```ts
import { mcpManager } from './mcp-manager';
mcpManager.init(); // load configs, do NOT connect
```

- [ ] **Step 8: Commit** — `feat(mcp): background manager with cache, rate limit, breaker`.

---

## Task 5: Wire MCP Tools into Agent Sessions

**Files:**
- Modify: `lib/tools/index.ts`
- Modify: `entrypoints/background/agent-manager.ts`

- [ ] **Step 1: Extend `createSessionTools`**

```ts
export function createSessionTools(opts: { mcpTools?: AgentTool<any>[] } = {}): {
  tools: AgentTool<any>[];
  ctx: SessionToolContext;
} {
  const ctx = new SessionToolContext();
  const { tool: askUserTool, bridge: askUserBridge } = createSessionAskUserTool();
  ctx.register(TOOL_ASK_USER, askUserBridge);

  const mcp = opts.mcpTools ?? [];
  // Defensive: drop any prefixed names that would shadow built-ins
  const builtinNames = new Set(sharedTools.map(t => t.name).concat(askUserTool.name));
  const safeMcp = mcp.filter(t => !builtinNames.has(t.name));

  return { tools: [askUserTool, ...sharedTools, ...safeMcp], ctx };
}
```

- [ ] **Step 2: Resolve MCP tools in agent-manager**

In `agent-manager.createAgent(...)`, after resolving model:
```ts
const mcpTools = await mcpManager.collectAllEnabledTools(); // gathers via Promise.allSettled
const { tools: sessionTools, ctx: toolCtx } = createSessionTools({ mcpTools });
```

`mcpManager.collectAllEnabledTools()`:
- iterates enabled servers,
- calls `listTools(id)` (cached),
- adapts each to `AgentTool` with the correct prefix,
- swallows individual server failures (logs, marks `error` status).

- [ ] **Step 3: Cache invalidation triggers session-tool refresh**

When user enables / disables / edits a server config, broadcast `mcp_status` and call `agentManager.invalidateSessionsAndRecreateOnNextPrompt()` (a new lightweight invalidation flag that forces agents to recreate next time `prompt()` is called).

- [ ] **Step 4: Commit** — `feat(mcp): expose tools to agent sessions`.

---

## Task 6: Settings UI

**Files:**
- Create: `components/settings/sections/McpSection.tsx`
- Create: `components/settings/mcp/McpServerForm.tsx`
- Create: `components/settings/mcp/McpJsonEditor.tsx`
- Modify: `components/settings/SectionNav.tsx`
- Modify: i18n locale files

- [ ] **Step 1: List view (`McpSection.tsx`)**

Layout:
```
[+ Add server]                             [{} Edit as JSON]

┌─────────────────────────────────────────────┐
│ ● github-tools     [Connected · 12 tools]    │
│   https://mcp.example.com/github             │
│   Bearer ✓                                   │
│   [Test] [Edit] [Disable] [Delete]          │
├─────────────────────────────────────────────┤
│ ⚠ local-fs        [Circuit open · retry 3:21]│
│   http://localhost:3000/mcp                  │
│   [Reset] [Edit] [Delete]                   │
└─────────────────────────────────────────────┘
```

Status indicator color: connected=green, idle=muted, rate-limited=yellow, error=orange, circuit-open=red.

- [ ] **Step 2: Form (`McpServerForm.tsx`)**

Fields:
- `name` — required, must be unique (validated against existing configs).
- `url` — required, validated as URL (allow http for localhost, https otherwise).
- `auth` — `Select { None, Bearer, Custom Header }` → conditional inputs.
- `toolPrefix` — optional; placeholder shows generated default.
- `enabled` — `Switch`.
- "Test connection" button — calls `mcp_test` port message → shows discovered tool list inline.

- [ ] **Step 3: JSON editor (`McpJsonEditor.tsx`)**

Reuse existing `CodeMirrorEditor`. Validate against a TypeBox schema for `CebianMcpServerConfig[]` on save (pretty-print Zod-style errors). Round-trip safe.

- [ ] **Step 4: Wire `mcp_test` / `mcp_reset` protocol**

```ts
// lib/protocol.ts
| { type: 'mcp_test'; serverId: string }
| { type: 'mcp_reset'; serverId: string }
| { type: 'mcp_status'; servers: McpServerSnapshot[] }
| { type: 'mcp_test_result'; serverId: string; ok: boolean; tools?: string[]; error?: string }
```

- [ ] **Step 5: Commit** — `feat(mcp): settings UI`.

---

## Task 7: Verification

- [ ] **Step 1:** `pnpm check` — types + i18n lint pass.
- [ ] **Step 2: Manual smoke**
  - Add a public test MCP server (e.g. an `mcp-fetch` instance), test connection, see tools listed.
  - Open chat, ask the agent to use one of the MCP tools — verify the call routes through `mcpManager`, result returns, ToolCard renders.
  - Disable the server in settings — verify next chat turn no longer offers those tools.
  - Misconfigure URL → trigger 5 failures → verify circuit opens, UI shows cool-down timer.
  - Wait 5 min (or hack the clock) → click "Reset" → verify reconnect.
- [ ] **Step 3: Commit** — `chore(mcp): verification pass`.

---

## Risks / Notes

- **SDK versioning**: confirm `@modelcontextprotocol/sdk` >= a version that ships browser-friendly Streamable HTTP transport with no Node-only deps. If the SDK pulls in `node:*`, we may need to vendor a minimal client.
- **CORS**: `host_permissions: ['<all_urls>']` already covers cross-origin, but some MCP servers require specific `Origin` allow-listing — surface that in error messages.
- **SW lifetime**: connections are torn down when SW restarts; that's fine because everything is lazy and cached. Cache survives restart in storage indirectly via TTL re-discovery on next call.
- **Tool schema drift**: cached `inputSchema` may go stale; the 30-min TTL + `list_changed` notification cover this. Worst case: agent sends invalid args, server rejects, we surface the error.
- **Security**: never log token values. The "Edit as JSON" view should mask Bearer tokens unless the user explicitly clicks "Reveal" (defer to v2 if it complicates the editor).

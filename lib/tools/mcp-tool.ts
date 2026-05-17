import type { TSchema } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MCPServerConfig } from '@/lib/storage';
import type { MCPTool } from '@/lib/mcp/client';
import { getMCPManager, ThrottleError } from '@/lib/mcp/manager';

/**
 * Per-tool-call metadata for rendering an MCP App iframe in the chat.
 *
 * Populated by `createMCPAgentTool` whenever the bound MCP tool declares
 * a UI resource (`_meta.ui.resourceUri` per SEP-1865). The sidepanel
 * reads this from `AgentToolResult.details.mcpApp` to:
 *
 *   1. Look up the HTML for `resourceUri` via the BG `mcp_read_resource`
 *      port message (cached at the sidepanel level). Server identity
 *      comes from the sibling `details.server` already on every MCP
 *      tool result — we deliberately don't duplicate it here.
 *   2. Push `toolInput` to the iframe via `ui/notifications/tool-input`.
 *   3. Push `toolResult` to the iframe via `ui/notifications/tool-result`.
 *
 * Stored alongside the message in IndexedDB so re-opening an old chat can
 * re-render the iframe (the HTML itself is re-fetched, not persisted).
 *
 * `toolResult` is typed as the SDK's `CallToolResult` (the wire shape the
 * iframe receives via `ui/notifications/tool-result`) so consumers feed
 * `<AppRenderer>` without a cast. Our project-local `MCPToolResult` is
 * structurally a subset of it; the boundary narrowing happens once here,
 * inside `execute()`.
 */
export interface MCPAppDetails {
  /** UI resource URI from `_meta.ui.resourceUri`. Always `ui://...` in practice. */
  resourceUri: string;
  /** Verbatim tool call arguments — pushed to the iframe on init. */
  toolInput: Record<string, unknown>;
  /** Full `CallToolResult` envelope — pushed to the iframe after init. */
  toolResult: CallToolResult;
}

/**
 * Structural type guard for a tool result that should render as an MCP App
 * iframe. Validates the persisted shape rather than trusting a cast — DB
 * rows survive code refactors and third-party servers ship arbitrary
 * `_meta`, so a truthy check on `details.mcpApp` is not enough.
 *
 * Sidepanel `details` is typed `any` (per `ToolResultMessage<TDetails = any>`),
 * so this is the boundary where the contract is enforced. Co-located with
 * the producer (`createMCPAgentTool`) so the guard stays in sync if the
 * persisted shape evolves.
 */
export function isMcpAppResult(details: unknown): details is {
  server: { id: string; name: string };
  mcpApp: MCPAppDetails;
} {
  if (!details || typeof details !== 'object') return false;
  const d = details as { server?: unknown; mcpApp?: unknown };
  const server = d.server as { id?: unknown } | undefined;
  const mcpApp = d.mcpApp as { resourceUri?: unknown } | undefined;
  return (
    typeof server?.id === 'string' && server.id.length > 0 &&
    typeof mcpApp?.resourceUri === 'string' && mcpApp.resourceUri.length > 0
  );
}

/**
 * Build an `AgentTool` that proxies to one MCP tool on one server.
 *
 * The agent invokes by name `mcp__<slug>__<toolName>` where `<slug>` is a
 * sanitized form of the server's user-given name (which is enforced unique
 * by the store). Encoding the slug rather than an opaque short id keeps tool
 * calls readable in logs and lets the chat UI render a human label without a
 * runtime registry lookup. See `getToolLabel` in `lib/tools/tool-labels.ts`.
 */
export function createMCPAgentTool(
  server: MCPServerConfig,
  mcpTool: MCPTool,
): AgentTool<TSchema> {
  const slug = slugifyServerName(server.name);
  // Sanitize remote tool name: providers (OpenAI/Anthropic/Gemini) require
  // ^[a-zA-Z0-9_-]+$. Keep the combined name within OpenAI's 64-char limit:
  // `mcp__` (5) + slug (≤20) + `__` (2) = 27 prefix chars, leaving 37 for
  // the tool name.
  const safeName = mcpTool.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 37);
  if (safeName !== mcpTool.name) {
    console.warn(`[mcp] sanitized tool name "${mcpTool.name}" → "${safeName}" for server "${server.name}"`);
  }
  const name = `mcp__${slug}__${safeName}`;
  const label = `${server.name} / ${mcpTool.name}`;
  const description = `[MCP: ${server.name}] ${mcpTool.description ?? mcpTool.name}`;
  // MCP tool inputSchema is JSON Schema; TypeBox TSchema is structurally
  // compatible (it's JSON Schema with extra metadata). The cast is safe at
  // the boundary — the agent runtime treats the schema opaquely.
  const parameters = mcpTool.inputSchema as unknown as TSchema;

  // Type-guard the UI metadata at construction time: only treat the tool
  // as MCP-App-capable when `_meta.ui.resourceUri` is a non-empty string.
  // Third-party MCP servers ship arbitrary `_meta` values; an undefined
  // / non-string slot must not produce a phantom `mcpApp` payload that
  // the renderer would then fail to load.
  //
  // Lenient on the scheme: spec says the URI MUST start with `ui://` but
  // we accept anything non-empty and let `resources/read` surface the
  // real failure. We warn here so an off-spec server is still observable
  // in the BG console rather than producing a silent later-stage error.
  const rawResourceUri = mcpTool._meta?.ui?.resourceUri;
  const uiResourceUri = typeof rawResourceUri === 'string' && rawResourceUri.length > 0
    ? rawResourceUri
    : undefined;
  if (uiResourceUri && !uiResourceUri.startsWith('ui://')) {
    console.warn(`[mcp] tool "${mcpTool.name}" on "${server.name}" has non-ui:// resourceUri "${uiResourceUri}" — SEP-1865 requires "ui://" scheme`);
  }

  return {
    name,
    label,
    description,
    parameters,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<{
      server: { id: string; name: string };
      tool: string;
      structured?: unknown;
      mcpApp?: MCPAppDetails;
    }>> {
      signal?.throwIfAborted();
      const manager = getMCPManager();
      try {
        const result = await manager.callTool(server.id, mcpTool.name, params as Record<string, unknown>);
        if (result.isError) {
          // v1 limitation: an errored MCP-App tool call is reported to
          // the LLM via the thrown error but does NOT push a `tool-result`
          // notification to the iframe — the iframe simply never renders
          // for this call. Per SEP-1865 "Data Passing", strictly the
          // iframe should receive the errored CallToolResult so it can
          // render its own error state, but draw.io and other v1-target
          // apps have nothing useful to render without a successful
          // result anyway. Revisit if a future app needs error-state UX.
          throw new Error(extractText(result.content) || `MCP tool "${mcpTool.name}" returned an error`);
        }
        const toolInput = (params as Record<string, unknown>) ?? {};
        const mcpApp: MCPAppDetails | undefined = uiResourceUri
          ? {
              resourceUri: uiResourceUri,
              toolInput,
              // Project-local `MCPToolResult` is a structural subset of
              // the SDK's `CallToolResult` (same fields, slightly looser
              // `content` element typing). The cast is safe at this
              // origin boundary; consumers (e.g. `ToolCardWithUI`) read
              // a strongly typed `CallToolResult` without a cast.
              toolResult: result as CallToolResult,
            }
          : undefined;
        return {
          content: convertContent(result.content),
          details: {
            server: { id: server.id, name: server.name },
            tool: mcpTool.name,
            structured: result.structuredContent,
            ...(mcpApp ? { mcpApp } : {}),
          },
        };
      } catch (err) {
        if (err instanceof ThrottleError) {
          const seconds = Math.max(1, Math.ceil(err.rejection.retryAfterMs / 1000));
          throw new Error(`MCP server "${server.name}" is throttled (${err.rejection.reason}); retry in ${seconds}s`);
        }
        throw err;
      }
    },
  };
}

interface RawContentBlock { type: string; [k: string]: unknown }

function convertContent(blocks: RawContentBlock[]): Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> {
  const out: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      out.push({ type: 'image', data: block.data, mimeType: block.mimeType });
    } else {
      // audio / resource / unknown — surface as text so the model sees something.
      out.push({ type: 'text', text: `[unsupported MCP content type: ${block.type}]` });
    }
  }
  if (out.length === 0) out.push({ type: 'text', text: '(empty result)' });
  return out;
}

function extractText(blocks: RawContentBlock[]): string {
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

/**
 * Convert a server's user-facing name into a tool-name-safe slug.
 *
 * Lowercase, ASCII-only ([a-z0-9_-]), capped at 20 chars. The store enforces
 * case-insensitive uniqueness on display names, but two distinct display
 * names CAN slugify to the same value (e.g. "GitHub Personal" and
 * "github_personal"). That collision would surface as a tool-name conflict
 * inside the agent runtime — acceptable for v1; the user can rename to
 * resolve. Keep this in sync with `parseMCPToolName` in tool-labels.ts.
 */
export function slugifyServerName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '_') // collapse runs of disallowed chars to one '_'
    .replace(/^_+|_+$/g, '')
    .slice(0, 20);
  // Always return at least something — empty slug would produce `mcp____tool`.
  return slug || 'server';
}

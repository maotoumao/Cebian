import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type {
  jsonSchemaValidator,
  JsonSchemaType,
  JsonSchemaValidator,
  JsonSchemaValidatorResult,
} from '@modelcontextprotocol/sdk/validation/types.js';
import { Value } from 'typebox/value';
import type { MCPServerConfig } from '@/lib/storage';

/**
 * Subset of `_meta.ui` we read on `Tool`s (per MCP Apps SEP-1865).
 *
 * Servers attach this to advertise a UI resource that the host should render
 * alongside the tool result. Only the keys Cebian actively consumes are
 * typed; `_meta` itself is open (the spec reserves the namespace, not the
 * concrete schema).
 */
export interface MCPToolUIMeta {
  resourceUri?: string;
  visibility?: Array<'model' | 'app'>;
}

/** Tool descriptor as returned by an MCP server's `tools/list`. */
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
  /** Server-attached metadata. We currently only consume `_meta.ui`. */
  _meta?: { ui?: MCPToolUIMeta; [k: string]: unknown };
}

/** Result of `tools/call`. */
export interface MCPToolResult {
  content: Array<{ type: string; [k: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
  /**
   * Server-attached metadata. Forwarded verbatim — for MCP Apps the
   * sidepanel needs to push this to the iframe via
   * `ui/notifications/tool-result` (SEP-1865, "Data Passing").
   */
  _meta?: Record<string, unknown>;
}

/**
 * One content entry of a `resources/read` response.
 *
 * Per MCP base spec the array can hold either `TextResourceContents` or
 * `BlobResourceContents`; for MCP Apps `_meta.ui` carries the sandbox /
 * CSP / permissions config the host must enforce when rendering the HTML.
 */
export interface MCPResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

const CLIENT_NAME = 'cebian';
const CLIENT_VERSION = '0.0.0';

/**
 * MCP Apps extension identifier. Advertised in `initialize.capabilities` so
 * servers know they can return `_meta.ui.resourceUri` on tools.
 *
 * See https://github.com/modelcontextprotocol/ext-apps spec 2026-01-26.
 */
const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';
const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * TypeBox-backed JSON Schema validator for the MCP Client.
 *
 * ## Why
 *
 * The SDK's default `AjvJsonSchemaValidator` compiles JSON Schemas via Ajv,
 * which uses `new Function(...)`. That is blocked by the MV3 service worker
 * CSP (no `unsafe-eval`). We use `typebox/value`'s pure-JS `Value.Check`,
 * which evaluates plain JSON Schemas directly without code generation and
 * therefore runs in eval-restricted runtimes.
 *
 * ## What it validates
 *
 * The SDK uses this validator to verify a tool result's `structuredContent`
 * field against the tool's declared `outputSchema` (see
 * `Client.getToolOutputValidator` / `Client.callTool`). Tool *input*
 * validation is unaffected — that is handled by the agent runtime against the
 * AgentTool wrappers in `lib/tools/mcp-tool.ts`.
 *
 * ## Lenient mode
 *
 * MCP server output schemas are authored by third parties and frequently use
 * features or quirks that don't translate one-to-one between AJV and
 * `typebox/value`. To avoid spurious failures that would break otherwise
 * working tools:
 *   - Schemas TypeBox can't process at all are passed through as `valid`.
 *   - `additionalProperties` defaults to permissive (matching AJV's default
 *     when unspecified), so extra fields don't fail validation.
 */
const typeboxSchemaValidator: jsonSchemaValidator = {
  getValidator: <T>(schema: JsonSchemaType): JsonSchemaValidator<T> => {
    return (input: unknown): JsonSchemaValidatorResult<T> => {
      try {
        if (Value.Check(schema, input)) {
          return { valid: true, data: input as T, errorMessage: undefined };
        }
        const firstError = Value.Errors(schema, input)[0];
        const path = firstError?.instancePath || '/';
        const message = firstError?.message ?? 'schema validation failed';
        return {
          valid: false,
          data: undefined,
          errorMessage: `${path}: ${message}`,
        };
      } catch (err) {
        // Schema couldn't be processed by typebox — be lenient and accept,
        // but log so the silent acceptance is observable when diagnosing a
        // third-party MCP tool whose outputSchema TypeBox can't evaluate.
        console.warn('[mcp] outputSchema unprocessable, accepting structuredContent unchecked', err);
        return { valid: true, data: input as T, errorMessage: undefined };
      }
    };
  },
};

/**
 * Thin wrapper around `@modelcontextprotocol/sdk` Client + transport.
 *
 * Single responsibility: speak MCP. Does NOT implement caching, throttling,
 * lifecycle management, or storage — those belong to the MCP manager (Task 4).
 *
 * Construct, `connect()`, use `listTools()` / `callTool()`, then `close()`.
 */
export class MCPClient {
  private readonly config: MCPServerConfig;
  private client?: Client;
  private transport?: Transport;
  private connected = false;

  constructor(config: MCPServerConfig) {
    this.config = config;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const url = new URL(this.config.transport.url);
    const requestInit = this.buildRequestInit();
    this.transport = this.config.transport.type === 'sse'
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });
    // Declare MCP Apps support so servers will attach `_meta.ui.resourceUri`
    // to tools that ship an interactive view. SDK 1.29's `ClientCapabilities`
    // type does not yet model the `extensions` key (added in newer spec
    // drafts), but the client sends `capabilities` verbatim on the wire — so
    // the cast at the call site is a typing escape, not a runtime hack. The
    // literal itself stays structurally checked.
    const capabilities = {
      extensions: {
        [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APPS_MIME_TYPE] },
      },
    };
    this.client = new Client(
      { name: CLIENT_NAME, version: CLIENT_VERSION },
      {
        capabilities: capabilities as ClientCapabilities,
        jsonSchemaValidator: typeboxSchemaValidator,
      },
    );
    try {
      await this.client.connect(this.transport);
      this.connected = true;
    } catch (err) {
      try { await this.transport.close?.(); } catch { /* swallow */ }
      this.client = undefined;
      this.transport = undefined;
      throw err;
    }
  }

  async listTools(): Promise<MCPTool[]> {
    this.assertConnected();
    const tools: MCPTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client!.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        // `_meta` is a standard MCP field on Tool; the SDK preserves it
        // through `tools/list`. Cast keeps us source-compatible with older
        // SDK type defs that don't surface `_meta` explicitly.
        const raw = t as typeof t & { _meta?: Record<string, unknown> };
        tools.push({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as MCPTool['inputSchema'],
          _meta: raw._meta as MCPTool['_meta'],
        });
      }
      cursor = page.nextCursor as string | undefined;
    } while (cursor);
    return tools;
  }

  /**
   * Read an MCP resource (typically a `ui://` UI resource for MCP Apps).
   *
   * Returns the first matching content entry. The spec allows `contents` to
   * hold multiple entries (e.g., directory reads), but for the `ui://` use
   * case servers return exactly one. If the response is empty, throws — the
   * caller treats that as a fetch failure.
   */
  async readResource(uri: string): Promise<MCPResourceContents> {
    this.assertConnected();
    const result = await this.client!.readResource({ uri });
    const contents = result.contents as MCPResourceContents[] | undefined;
    if (!contents || contents.length === 0) {
      throw new Error(`MCP resource "${uri}" returned no contents`);
    }
    // Prefer an entry whose URI matches exactly; fall back to the first.
    return contents.find((c) => c.uri === uri) ?? contents[0]!;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    this.assertConnected();
    const result = await this.client!.callTool({ name, arguments: args });
    // `_meta` on the result envelope is a standard MCP field; cast keeps
    // us source-compatible with SDK type defs that don't surface it.
    const raw = result as typeof result & { _meta?: Record<string, unknown> };
    return {
      content: (result.content as MCPToolResult['content']) ?? [],
      structuredContent: result.structuredContent,
      isError: result.isError as boolean | undefined,
      _meta: raw._meta,
    };
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.client?.close();
    } finally {
      this.connected = false;
      this.client = undefined;
      this.transport = undefined;
    }
  }

  private assertConnected(): void {
    if (!this.connected || !this.client) {
      throw new Error(`MCP client for "${this.config.name}" is not connected`);
    }
  }

  private buildRequestInit(): RequestInit | undefined {
    // Use Headers to handle case-insensitive collision (e.g. user supplied
    // 'authorization' lowercase + bearer auth wants 'Authorization').
    const h = new Headers(this.config.transport.headers ?? {});
    if (this.config.auth.type === 'bearer') {
      h.set('Authorization', `Bearer ${this.config.auth.token}`);
    }
    let empty = true;
    h.forEach(() => { empty = false; });
    return empty ? undefined : { headers: h };
  }
}

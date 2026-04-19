import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { MCPServerConfig } from '@/lib/storage';

/** Tool descriptor as returned by an MCP server's `tools/list`. */
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
}

/** Result of `tools/call`. */
export interface MCPToolResult {
  content: Array<{ type: string; [k: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

const CLIENT_NAME = 'cebian';
const CLIENT_VERSION = '0.0.0';

/**
 * No-op JSON Schema validator for the MCP Client.
 *
 * The SDK's default `AjvJsonSchemaValidator` compiles schemas via Ajv, which
 * uses `new Function(...)` — blocked by the MV3 service worker CSP
 * (no `unsafe-eval`). We accept all structured tool output without validation;
 * downstream consumers (the LLM) are tolerant of extra/missing fields.
 */
const noopSchemaValidator = {
  getValidator: <T>() => (input: unknown) => ({
    valid: true as const,
    data: input as T,
    errorMessage: undefined,
  }),
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
    this.client = new Client(
      { name: CLIENT_NAME, version: CLIENT_VERSION },
      { capabilities: {}, jsonSchemaValidator: noopSchemaValidator as any },
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
        tools.push({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as MCPTool['inputSchema'],
        });
      }
      cursor = page.nextCursor as string | undefined;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    this.assertConnected();
    const result = await this.client!.callTool({ name, arguments: args });
    return {
      content: (result.content as MCPToolResult['content']) ?? [],
      structuredContent: result.structuredContent,
      isError: result.isError as boolean | undefined,
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

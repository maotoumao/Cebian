import type { TSchema } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { MCPServerConfig } from '@/lib/storage';
import type { MCPTool } from '@/lib/mcp/client';
import { getMCPManager, ThrottleError } from '@/lib/mcp/manager';

/**
 * Build an `AgentTool` that proxies to one MCP tool on one server.
 *
 * The agent invokes by name `mcp__<shortServerId>__<toolName>` (server prefix
 * keeps tool names unique across multiple MCP servers and limits collisions
 * with built-in tools that never start with `mcp__`).
 */
export function createMCPAgentTool(
  server: MCPServerConfig,
  mcpTool: MCPTool,
): AgentTool<TSchema> {
  const shortId = server.id.replace(/-/g, '').slice(0, 8);
  // Sanitize remote tool name: providers (OpenAI/Anthropic/Gemini) require
  // ^[a-zA-Z0-9_-]+$ and limit total length. Cap at 48 to leave headroom
  // under OpenAI's 64-char limit (`mcp__` + 8 + `__` = 15 prefix chars).
  const safeName = mcpTool.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  if (safeName !== mcpTool.name) {
    console.warn(`[mcp] sanitized tool name "${mcpTool.name}" → "${safeName}" for server "${server.name}"`);
  }
  const name = `mcp__${shortId}__${safeName}`;
  const label = `${server.name} / ${mcpTool.name}`;
  const description = `[MCP: ${server.name}] ${mcpTool.description ?? mcpTool.name}`;
  // MCP tool inputSchema is JSON Schema; TypeBox TSchema is structurally
  // compatible (it's JSON Schema with extra metadata). The cast is safe at
  // the boundary — the agent runtime treats the schema opaquely.
  const parameters = mcpTool.inputSchema as unknown as TSchema;

  return {
    name,
    label,
    description,
    parameters,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<{
      server: { id: string; name: string };
      tool: string;
      structured?: unknown;
    }>> {
      signal?.throwIfAborted();
      const manager = getMCPManager();
      try {
        const result = await manager.callTool(server.id, mcpTool.name, params as Record<string, unknown>);
        if (result.isError) {
          throw new Error(extractText(result.content) || `MCP tool "${mcpTool.name}" returned an error`);
        }
        return {
          content: convertContent(result.content),
          details: {
            server: { id: server.id, name: server.name },
            tool: mcpTool.name,
            structured: result.structuredContent,
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

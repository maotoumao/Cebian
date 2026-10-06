import { describe, it, expect, vi } from 'vitest';
import { assertJsonSerializable } from '@/lib/shims/pi-harness/session/session';
import type { MCPServerConfig } from '@/lib/persistence/storage';
import { createMCPAgentTool } from '@/lib/tools/mcp-tool';

const { callTool } = vi.hoisted(() => ({ callTool: vi.fn() }));
vi.mock('@/lib/mcp/manager', () => ({
  getMCPManager: () => ({ callTool }),
  ThrottleError: class ThrottleError extends Error {},
}));

const server: MCPServerConfig = {
  id: 'srv-1',
  name: 'edgeone',
  enabled: true,
  transport: { type: 'streamable-http', url: 'https://example.test/mcp' },
  auth: { type: 'none' },
} as MCPServerConfig;

const mcpTool = {
  name: 'deploy-html',
  inputSchema: { type: 'object' as const, properties: { value: { type: 'string' } }, required: ['value'] },
};

async function execute() {
  const tool = createMCPAgentTool(server, mcpTool);
  return tool.execute('call-1', { value: 'x' }, undefined);
}

describe('createMCPAgentTool · 工具结果的 details', () => {
  it('服务端不返回 structuredContent 时不写 `structured` 字段，结果满足 durable payload 契约（issue #74）', async () => {
    callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'deployed' }] });
    const result = await execute();
    expect(Object.hasOwn(result.details, 'structured')).toBe(false);
    expect(() => assertJsonSerializable(result)).not.toThrow();
  });

  it('服务端返回 structuredContent 时原样透出到 details.structured', async () => {
    callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }], structuredContent: { url: 'https://x' } });
    const result = await execute();
    expect(result.details.structured).toEqual({ url: 'https://x' });
  });
});

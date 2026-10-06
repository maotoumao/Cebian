import { describe, expect, it } from 'vitest';
import type { MCPServerConfig } from '@/lib/persistence/storage';
import { buildOriginRules } from './origin-rules';

function server(id: string, url: string, enabled = true): MCPServerConfig {
  return {
    id,
    name: id,
    enabled,
    transport: { type: 'streamable-http', url },
    auth: { type: 'none' },
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('buildOriginRules', () => {
  it('只对本扩展发往启用服务器 origin 的请求删 Origin 头', () => {
    const rules = buildOriginRules([server('a', 'https://mcp.cloudflare.com/mcp')], 'ext-id');
    expect(rules).toEqual([
      {
        id: 1,
        priority: 1,
        condition: {
          urlFilter: '|https://mcp.cloudflare.com/',
          initiatorDomains: ['ext-id'],
          resourceTypes: ['xmlhttprequest', 'other'],
        },
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'origin', operation: 'remove' }],
        },
      },
    ]);
  });

  it('禁用的服务器不出规则，同 origin 去重，端口保留', () => {
    const rules = buildOriginRules(
      [
        server('a', 'https://mcp.example.com/mcp'),
        server('b', 'https://mcp.example.com/other/sse'),
        server('c', 'http://127.0.0.1:8789/mcp'),
        server('d', 'https://disabled.example.com/mcp', false),
      ],
      'ext-id',
    );
    expect(rules.map((r) => r.condition.urlFilter)).toEqual([
      '|https://mcp.example.com/',
      '|http://127.0.0.1:8789/',
    ]);
    expect(rules.map((r) => r.id)).toEqual([1, 2]);
  });

  it('非法 URL 和非 http(s) 协议跳过', () => {
    const rules = buildOriginRules(
      [server('a', 'not a url'), server('b', 'ftp://example.com/mcp')],
      'ext-id',
    );
    expect(rules).toEqual([]);
  });

  it('主机名含通配符 * 的服务器跳过（含编码后的 %2a），避免规则扩到任意主机', () => {
    const rules = buildOriginRules(
      [server('a', 'https://*/mcp'), server('b', 'https://%2a/mcp'), server('c', 'https://a*b.example.com/mcp')],
      'ext-id',
    );
    expect(rules).toEqual([]);
  });
});

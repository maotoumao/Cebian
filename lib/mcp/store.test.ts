import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { addMCPServer, updateMCPServer, getMCPServer } from '@/lib/mcp/store';
import { formToInput } from '@/components/settings/mcp/MCPServerForm';

const withHeaders = {
  name: 'srv',
  transport: { type: 'streamable-http' as const, url: 'https://x.example/mcp', headers: { 'x-a': '1' } },
  auth: { type: 'none' as const },
};

describe('updateMCPServer — headers 清除/保留', () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it('清空所有 header 行后保存 → 持久化的 headers 消失（回归：编辑清空不生效）', async () => {
    const added = await addMCPServer(withHeaders);
    expect(added.transport.headers).toEqual({ 'x-a': '1' });

    const input = formToInput({
      name: 'srv',
      transportType: 'streamable-http',
      url: 'https://x.example/mcp',
      authType: 'none',
      bearerToken: '',
      headers: [],
    });
    await updateMCPServer(added.id, { name: input.name, transport: input.transport, auth: input.auth });

    const after = await getMCPServer(added.id);
    expect(after?.transport.headers).toBeUndefined();
  });

  it('部分 patch（只改 url）→ 保留既有 headers（浅合并契约）', async () => {
    const added = await addMCPServer(withHeaders);
    await updateMCPServer(added.id, { transport: { url: 'https://y.example/mcp' } });
    const after = await getMCPServer(added.id);
    expect(after?.transport.url).toBe('https://y.example/mcp');
    expect(after?.transport.headers).toEqual({ 'x-a': '1' });
  });
});

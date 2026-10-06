import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { mcpServers, type MCPServerConfig } from '@/lib/persistence/storage';
import { __resetMCPManager, getMCPManager } from './manager';

// 用可控的假 client 替换真实的 MCP 连接：connect 由测试手动放行或失败，便于构造
// 「连接进行中配置被改 / 被删」这类时序。
const { clients, FakeClient } = vi.hoisted(() => {
  class FakeClient {
    connected = false;
    private settle?: { resolve: () => void; reject: (err: Error) => void };
    readonly connect = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          this.settle = {
            resolve: () => {
              this.connected = true;
              resolve();
            },
            reject,
          };
        }),
    );
    readonly close = vi.fn(async () => {
      this.connected = false;
    });
    readonly listTools = vi.fn(async () => [{ name: 'echo', inputSchema: { type: 'object' } }]);

    constructor(readonly config: MCPServerConfig) {
      clients.push(this);
    }

    isConnected(): boolean {
      return this.connected;
    }

    finishConnect(): void {
      this.settle!.resolve();
    }

    failConnect(message: string): void {
      this.settle!.reject(new Error(message));
    }
  }
  const clients: FakeClient[] = [];
  return { clients, FakeClient };
});

vi.mock('./client', () => ({ MCPClient: FakeClient }));

function server(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id: 's1',
    name: 'S1',
    enabled: true,
    transport: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
    auth: { type: 'none' },
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 等第 index 个 client 被建出来并开始 connect（排在 init 与节流检查之后）。 */
async function connectStarted(index: number): Promise<InstanceType<typeof FakeClient>> {
  await vi.waitFor(() => expect(clients[index]?.connect).toHaveBeenCalled());
  return clients[index]!;
}

beforeEach(async () => {
  await __resetMCPManager();
  fakeBrowser.reset();
  clients.length = 0;
  vi.useRealTimers();
});

describe('MCPManager 连接期间配置变化', () => {
  it('连接中改了配置：旧请求失败、旧连接被关掉，新配置不留假错误和旧工具', async () => {
    await mcpServers.setValue([server()]);
    const mgr = getMCPManager();
    const pending = mgr.getTools('s1');
    const oldClient = await connectStarted(0);

    await mcpServers.setValue([server({ transport: { type: 'streamable-http', url: 'https://mcp.example.com/v2' } })]);
    await vi.waitFor(() => expect(clients).toHaveLength(2));

    oldClient.finishConnect();
    await expect(pending).rejects.toThrow(/reconfigured or removed while connecting/);
    // 删改时的 closeEntry 对还没连上的 client 是空操作，连上之后得由请求方自己关掉
    expect(oldClient.isConnected()).toBe(false);
    expect(oldClient.listTools).not.toHaveBeenCalled();

    const status = await mgr.getStatus('s1');
    expect(status).toEqual({ connected: false, breaker: 'CLOSED' });

    // 新配置的连接与旧那一轮互不干扰：能正常连上并拿到工具
    const fresh = mgr.getTools('s1');
    const newClient = await connectStarted(1);
    newClient.finishConnect();
    await expect(fresh).resolves.toHaveLength(1);
  });

  it('连接中服务器被删：请求失败，连上的旧连接被关掉', async () => {
    await mcpServers.setValue([server()]);
    const mgr = getMCPManager();
    const pending = mgr.getTools('s1');
    const client = await connectStarted(0);

    await mcpServers.setValue([]);
    await vi.waitFor(async () => expect(await mgr.getStatus('s1')).toBeUndefined());

    client.finishConnect();
    await expect(pending).rejects.toThrow(/reconfigured or removed while connecting/);
    expect(client.isConnected()).toBe(false);
    expect(client.listTools).not.toHaveBeenCalled();
  });
});

describe('MCPManager.connectIfIdle', () => {
  it('失败后冷却期内不重试，过了冷却期再试一次', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000);
    await mcpServers.setValue([server()]);
    const mgr = getMCPManager();

    const first = mgr.connectIfIdle('s1');
    const client = await connectStarted(0);
    client.failConnect('Invalid Origin');
    await first;
    const lastError = (await mgr.getStatus('s1'))?.lastError;
    expect(lastError?.message).toBe('Invalid Origin');
    // vi.waitFor 在假计时器下会推进时间，所以以记下的失败时刻为基准
    const failedAt = lastError!.at;

    vi.setSystemTime(failedAt + 29_000);
    await mgr.connectIfIdle('s1');
    expect(client.connect).toHaveBeenCalledTimes(1);

    vi.setSystemTime(failedAt + 30_000);
    const retry = mgr.connectIfIdle('s1');
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledTimes(2));
    client.finishConnect();
    await retry;
    expect(await mgr.getStatus('s1')).toEqual({ connected: true, breaker: 'CLOSED' });
  });

  it('已禁用的服务器不试连', async () => {
    await mcpServers.setValue([server({ enabled: false })]);
    const mgr = getMCPManager();
    await mgr.connectIfIdle('s1');
    expect(clients[0]!.connect).not.toHaveBeenCalled();
  });

  it('已连上的服务器不再试连', async () => {
    await mcpServers.setValue([server()]);
    const mgr = getMCPManager();
    const first = mgr.connectIfIdle('s1');
    const client = await connectStarted(0);
    client.finishConnect();
    await first;
    await mgr.connectIfIdle('s1');
    expect(client.connect).toHaveBeenCalledTimes(1);
  });
});

describe('MCPManager connect gate', () => {
  it('连接等 gate 放行后才发出', async () => {
    await mcpServers.setValue([server()]);
    const mgr = getMCPManager();
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    mgr.setConnectGate(() => gate);

    const pending = mgr.getTools('s1');
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(clients[0]!.connect).not.toHaveBeenCalled();

    openGate();
    const client = await connectStarted(0);
    client.finishConnect();
    await expect(pending).resolves.toHaveLength(1);
  });

  it.each([
    ['禁用', (s: MCPServerConfig) => [{ ...s, enabled: false }]],
    ['删除', () => []],
    ['改地址', (s: MCPServerConfig) => [{ ...s, transport: { type: 'streamable-http' as const, url: 'https://mcp.example.com/v2' } }]],
  ])('等 gate 期间被%s：旧 client 不再发起连接', async (_label, next) => {
    const original = server();
    await mcpServers.setValue([original]);
    const mgr = getMCPManager();
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    mgr.setConnectGate(() => gate);

    const pending = mgr.getTools('s1');
    await vi.waitFor(() => expect(clients).toHaveLength(1));
    const oldClient = clients[0]!;
    const settled = expect(pending).rejects.toThrow(/reconfigured or removed while connecting/);

    await mcpServers.setValue(next(original));
    await vi.waitFor(async () => {
      const status = await mgr.getStatus('s1');
      expect(status === undefined || clients.length === 2).toBe(true);
    });
    openGate();
    await settled;
    expect(oldClient.connect).not.toHaveBeenCalled();
  });
});

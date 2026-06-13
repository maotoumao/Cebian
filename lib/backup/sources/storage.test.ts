import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  collectStorage,
  restoreStorage,
  type CollectedStorage,
} from '@/lib/backup/sources/storage';
import {
  activeModel,
  userInstructions,
  customProviders,
  mcpServers,
  providerCredentials,
  webdavConfig,
  type MCPServerConfig,
  type ProviderCredentials,
  type CustomProviderConfig,
} from '@/lib/storage';

const SK = {
  activeModel: 'local:activeModel',
  userInstructions: 'local:userInstructions',
  customProviders: 'local:customProviders',
  mcpServers: 'local:mcpServers',
  providerCredentials: 'local:providerCredentials',
  webdavConfig: 'local:webdavConfig',
};

function bearerServer(id: string, token: string): MCPServerConfig {
  return {
    id,
    name: id,
    enabled: true,
    transport: { type: 'streamable-http', url: `https://${id}.example/mcp` },
    auth: { type: 'bearer', token },
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 2,
  };
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe('collectStorage', () => {
  it('settings 含非密钥项，且绝不含任何密钥', async () => {
    await activeModel.setValue({ provider: 'openai', modelId: 'gpt' });
    await userInstructions.setValue('hi');
    await mcpServers.setValue([bearerServer('s1', 'mcp-secret')]);
    await providerCredentials.setValue({ openai: { authType: 'apiKey', apiKey: 'sk-x', verified: true } });

    const { config, credentials } = await collectStorage({ settings: true, credentials: true });

    expect(config![SK.activeModel]).toEqual({ provider: 'openai', modelId: 'gpt' });
    expect(config![SK.userInstructions]).toBe('hi');
    // mcpServers 的 safe 部分在 config，但 token 被清空。
    const safeServers = config![SK.mcpServers] as MCPServerConfig[];
    expect(safeServers[0].auth).toEqual({ type: 'bearer', token: '' });
    // config 序列化后绝不含任何密钥明文。
    const configJson = JSON.stringify(config);
    expect(configJson).not.toContain('mcp-secret');
    expect(configJson).not.toContain('sk-x');
  });

  it('mcpServers 的 token 落在 credentials', async () => {
    await mcpServers.setValue([bearerServer('s1', 'mcp-secret')]);
    const { credentials } = await collectStorage({ settings: true, credentials: true });
    expect(JSON.stringify(credentials![SK.mcpServers])).toContain('mcp-secret');
  });

  it('只选 settings：credentials 为 undefined，密钥不被序列化', async () => {
    await mcpServers.setValue([bearerServer('s1', 'mcp-secret')]);
    await providerCredentials.setValue({ openai: { authType: 'apiKey', apiKey: 'sk-x', verified: true } });
    const out = await collectStorage({ settings: true, credentials: false });
    expect(out.credentials).toBeUndefined();
    expect(out.config).toBeDefined();
    expect(JSON.stringify(out.config)).not.toContain('mcp-secret');
    expect(JSON.stringify(out.config)).not.toContain('sk-x');
  });

  it('只选 credentials：config 为 undefined', async () => {
    await providerCredentials.setValue({ openai: { authType: 'apiKey', apiKey: 'sk-x', verified: true } });
    const out = await collectStorage({ settings: false, credentials: true });
    expect(out.config).toBeUndefined();
    expect(JSON.stringify(out.credentials)).toContain('sk-x');
  });
});

describe('restoreStorage — replace', () => {
  it('settings 用备份覆盖；混合 item 用 secret 重组 token', async () => {
    // 本地是另一套值。
    await activeModel.setValue({ provider: 'local', modelId: 'm' });
    await mcpServers.setValue([bearerServer('s1', 'local-token')]);

    const data: CollectedStorage = {
      config: {
        [SK.activeModel]: { provider: 'backup', modelId: 'b' },
        [SK.mcpServers]: [bearerServer('s1', '')],
      },
      credentials: {
        [SK.mcpServers]: { s1: { token: 'backup-token' } },
      },
    };
    await restoreStorage(data, { strategy: 'replace', settings: true, credentials: true });

    expect(await activeModel.getValue()).toEqual({ provider: 'backup', modelId: 'b' });
    const servers = await mcpServers.getValue();
    expect(servers[0].auth).toEqual({ type: 'bearer', token: 'backup-token' });
  });

  it('replace 但未选 credentials：混合 item token 留空', async () => {
    await mcpServers.setValue([bearerServer('s1', 'local-token')]);
    const data: CollectedStorage = {
      config: { [SK.mcpServers]: [bearerServer('s1', '')] },
      credentials: { [SK.mcpServers]: { s1: { token: 'backup-token' } } },
    };
    await restoreStorage(data, { strategy: 'replace', settings: true, credentials: false });
    const servers = await mcpServers.getValue();
    expect(servers[0].auth).toEqual({ type: 'bearer', token: '' });
  });

  it('config 里残留 token / header 被无条件剥离（不可信输入防线）', async () => {
    // 构造一个被污染的 config：混合 item 仍带 token 和自定义 header。
    const polluted: MCPServerConfig = {
      ...bearerServer('s1', 'leaked-token'),
      transport: {
        type: 'streamable-http',
        url: 'https://s1.example/mcp',
        headers: { 'X-Api-Key': 'leaked-header' },
      },
    };
    const data: CollectedStorage = {
      config: { [SK.mcpServers]: [polluted] },
      // 未选 credentials，故不提供 secret。
    };
    await restoreStorage(data, { strategy: 'replace', settings: true, credentials: false });
    const servers = await mcpServers.getValue();
    expect(servers[0].auth).toEqual({ type: 'bearer', token: '' });
    expect(servers[0].transport.headers).toBeUndefined();
  });

  it('credentials 用备份整体覆盖', async () => {
    await providerCredentials.setValue({ openai: { authType: 'apiKey', apiKey: 'local', verified: true } });
    const data: CollectedStorage = {
      credentials: {
        [SK.providerCredentials]: { anthropic: { authType: 'apiKey', apiKey: 'backup', verified: true } },
      },
    };
    await restoreStorage(data, { strategy: 'replace', settings: false, credentials: true });
    const creds = await providerCredentials.getValue();
    expect(creds.openai).toBeUndefined();
    expect(creds.anthropic).toBeDefined();
  });
});

describe('restoreStorage — 混合 item 的密钥单独随 credentials 恢复', () => {
  it('只选 credentials（不选 settings）时，MCP 密钥写进本地已有 server（replace 覆盖）', async () => {
    await mcpServers.setValue([bearerServer('s1', 'local-token')]);
    const data: CollectedStorage = {
      credentials: { [SK.mcpServers]: { s1: { token: 'backup-token' } } },
    };
    await restoreStorage(data, { strategy: 'replace', settings: false, credentials: true });
    const servers = await mcpServers.getValue();
    // 本地配置保留、token 被备份覆盖。
    expect(servers[0].id).toBe('s1');
    expect(servers[0].auth).toEqual({ type: 'bearer', token: 'backup-token' });
  });

  it('只选 credentials + merge：本地已有 token 保留、缺失的才补', async () => {
    await mcpServers.setValue([
      bearerServer('s1', 'local-live-token'), // 本地有有效 token
      bearerServer('s2', ''), // 本地 token 空
    ]);
    const data: CollectedStorage = {
      credentials: {
        [SK.mcpServers]: { s1: { token: 'backup-1' }, s2: { token: 'backup-2' } },
      },
    };
    await restoreStorage(data, { strategy: 'merge', settings: false, credentials: true });
    const servers = await mcpServers.getValue();
    const s1 = servers.find((s) => s.id === 's1')!;
    const s2 = servers.find((s) => s.id === 's2')!;
    expect(s1.auth).toEqual({ type: 'bearer', token: 'local-live-token' }); // 保留本地
    expect(s2.auth).toEqual({ type: 'bearer', token: 'backup-2' }); // 补缺
  });

  it('备份 secret 含本地不存在的 server → 不凭空新增', async () => {
    await mcpServers.setValue([bearerServer('s1', '')]);
    const data: CollectedStorage = {
      credentials: {
        [SK.mcpServers]: { s1: { token: 't1' }, sX: { token: 'tX' } },
      },
    };
    await restoreStorage(data, { strategy: 'replace', settings: false, credentials: true });
    const servers = await mcpServers.getValue();
    expect(servers).toHaveLength(1);
    expect(servers[0].id).toBe('s1');
  });

  it('settings + credentials 同时 replace：safe 配置 + 密钥都还原', async () => {
    await mcpServers.setValue([bearerServer('s1', 'old')]);
    const data: CollectedStorage = {
      config: { [SK.mcpServers]: [bearerServer('s1', '')] },
      credentials: { [SK.mcpServers]: { s1: { token: 'restored' } } },
    };
    await restoreStorage(data, { strategy: 'replace', settings: true, credentials: true });
    const servers = await mcpServers.getValue();
    expect(servers[0].auth).toEqual({ type: 'bearer', token: 'restored' });
  });
});

describe('restoreStorage — merge', () => {
  it('标量设置（无 fillMissing）merge 下保留本地、不写', async () => {
    await activeModel.setValue({ provider: 'local', modelId: 'm' });
    const data: CollectedStorage = {
      config: { [SK.activeModel]: { provider: 'backup', modelId: 'b' } },
    };
    await restoreStorage(data, { strategy: 'merge', settings: true, credentials: false });
    expect(await activeModel.getValue()).toEqual({ provider: 'local', modelId: 'm' });
  });

  it('customProviders 按 id 补缺：本地已有保留、本地缺的从备份补入', async () => {
    const provLocal: CustomProviderConfig = {
      id: 'p-local',
      name: 'Local',
      baseUrl: 'https://local/v1',
      models: [],
    };
    const provBackupSame: CustomProviderConfig = {
      id: 'p-local',
      name: 'Backup overwrites? no',
      baseUrl: 'https://backup/v1',
      models: [],
    };
    const provBackupNew: CustomProviderConfig = {
      id: 'p-new',
      name: 'New from backup',
      baseUrl: 'https://new/v1',
      models: [],
    };
    await customProviders.setValue([provLocal]);

    const data: CollectedStorage = {
      config: { [SK.customProviders]: [provBackupSame, provBackupNew] },
    };
    await restoreStorage(data, { strategy: 'merge', settings: true, credentials: false });

    const result = await customProviders.getValue();
    const ids = result.map((p) => p.id).sort();
    expect(ids).toEqual(['p-local', 'p-new']);
    // 同 id 保留本地（name 不被备份覆盖）。
    expect(result.find((p) => p.id === 'p-local')!.name).toBe('Local');
    // 本地缺的从备份补入。
    expect(result.find((p) => p.id === 'p-new')!.name).toBe('New from backup');
  });

  it('customProviders 按 id 补缺：备份内部重复 id 只取首个、不重复灌入', async () => {
    const provDup1: CustomProviderConfig = {
      id: 'p-dup',
      name: 'First',
      baseUrl: 'https://first/v1',
      models: [],
    };
    const provDup2: CustomProviderConfig = {
      id: 'p-dup',
      name: 'Second',
      baseUrl: 'https://second/v1',
      models: [],
    };
    await customProviders.setValue([]);

    const data: CollectedStorage = {
      config: { [SK.customProviders]: [provDup1, provDup2] },
    };
    await restoreStorage(data, { strategy: 'merge', settings: true, credentials: false });

    const result = await customProviders.getValue();
    // 备份里两个同 id，只补入首个，不产生重复。
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p-dup');
    expect(result[0].name).toBe('First');
  });

  it('mcpServers 按 id 补缺：本地保留、备份新 server 补入，同选 credentials 时补入 token', async () => {
    await mcpServers.setValue([bearerServer('s-local', 'local-token')]);
    const data: CollectedStorage = {
      config: {
        [SK.mcpServers]: [
          bearerServer('s-local', ''), // safe 形态（token 已被 split 清空）
          bearerServer('s-new', ''),
        ],
      },
      credentials: {
        [SK.mcpServers]: { 's-new': { token: 'new-token' } },
      },
    };
    await restoreStorage(data, { strategy: 'merge', settings: true, credentials: true });

    const servers = await mcpServers.getValue();
    const sLocal = servers.find((s) => s.id === 's-local')!;
    const sNew = servers.find((s) => s.id === 's-new')!;
    // 本地 server 保留本地 token（不被覆盖）。
    expect(sLocal.auth).toEqual({ type: 'bearer', token: 'local-token' });
    // 备份新 server 补入，且其 token 由 credentials 补缺恢复。
    expect(sNew.auth).toEqual({ type: 'bearer', token: 'new-token' });
  });

  it('providerCredentials 逐 provider 补缺：本地已有的保留，缺的补入', async () => {
    const local: ProviderCredentials = {
      openai: { authType: 'apiKey', apiKey: 'local-openai', verified: true },
    };
    await providerCredentials.setValue(local);

    const data: CollectedStorage = {
      credentials: {
        [SK.providerCredentials]: {
          openai: { authType: 'apiKey', apiKey: 'backup-openai', verified: true },
          anthropic: { authType: 'apiKey', apiKey: 'backup-anthropic', verified: true },
        },
      },
    };
    await restoreStorage(data, { strategy: 'merge', settings: false, credentials: true });

    const creds = await providerCredentials.getValue();
    // openai 本地已有 → 保留本地。
    expect((creds.openai as { apiKey: string }).apiKey).toBe('local-openai');
    // anthropic 本地缺 → 从备份补入。
    expect((creds.anthropic as { apiKey: string }).apiKey).toBe('backup-anthropic');
  });

  it('webdavConfig 补缺：本地已配置则保留，本地为 null 才补入', async () => {
    const backup = { url: 'https://dav', username: 'u', password: 'p', directory: '/c' };

    // 本地已配置 → 保留本地。
    await webdavConfig.setValue({ url: 'https://local', username: 'lu', password: 'lp', directory: '/l' });
    await restoreStorage(
      { credentials: { [SK.webdavConfig]: backup } },
      { strategy: 'merge', settings: false, credentials: true },
    );
    expect((await webdavConfig.getValue())!.url).toBe('https://local');

    // 本地为 null → 补入备份。
    await webdavConfig.setValue(null);
    await restoreStorage(
      { credentials: { [SK.webdavConfig]: backup } },
      { strategy: 'merge', settings: false, credentials: true },
    );
    expect((await webdavConfig.getValue())!.url).toBe('https://dav');
  });
});

import { describe, it, expect } from 'vitest';
import * as storageModule from '@/lib/storage';
import type { MCPServerConfig } from '@/lib/storage';
import {
  BACKUP_REGISTRY,
  registeredStorageKeys,
  splitMcpTokens,
  restoreMcpSecrets,
} from '@/lib/backup/registry';

/** 判断一个导出是否是 WXT storage item（有 `key` 字符串与 `getValue` 方法）。 */
function isStorageItem(v: unknown): v is { key: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { key?: unknown }).key === 'string' &&
    typeof (v as { getValue?: unknown }).getValue === 'function'
  );
}

describe('BACKUP_REGISTRY 覆盖性', () => {
  it('lib/storage.ts 导出的每个 storage item 都已在注册表登记', () => {
    const registered = registeredStorageKeys();
    const missing: string[] = [];
    for (const value of Object.values(storageModule)) {
      if (isStorageItem(value) && !registered.has(value.key)) {
        missing.push(value.key);
      }
    }
    expect(missing).toEqual([]);
  });

  it('注册表里没有重复的 storage key', () => {
    const keys = BACKUP_REGISTRY.map((e) => e.item.key);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('混合 item 必须同时声明 splitSecret 与 restoreSecret', () => {
    for (const entry of BACKUP_REGISTRY) {
      const hasSplit = typeof entry.splitSecret === 'function';
      const hasRestoreSecret = typeof entry.restoreSecret === 'function';
      expect(hasSplit).toBe(hasRestoreSecret);
    }
  });

  it('每个 credentials-class item 必须声明 fillMissing（补缺语义不留静默默认）', () => {
    for (const entry of BACKUP_REGISTRY) {
      if (entry.storageClass === 'credentials') {
        expect(typeof entry.fillMissing).toBe('function');
      }
    }
  });
});

describe('mcpServers 密钥拆分 / 恢复', () => {
  const servers: MCPServerConfig[] = [
    {
      id: 'srv-none',
      name: 'No Auth',
      enabled: true,
      transport: { type: 'streamable-http', url: 'https://a.example/mcp' },
      auth: { type: 'none' },
      schemaVersion: 1,
      createdAt: 1,
      updatedAt: 2,
    },
    {
      id: 'srv-bearer',
      name: 'Bearer',
      enabled: true,
      transport: { type: 'sse', url: 'https://b.example/sse' },
      auth: { type: 'bearer', token: 'super-secret' },
      schemaVersion: 1,
      createdAt: 3,
      updatedAt: 4,
    },
    {
      id: 'srv-headers',
      name: 'Custom Headers',
      enabled: true,
      transport: {
        type: 'streamable-http',
        url: 'https://c.example/mcp',
        headers: { 'X-Api-Key': 'header-secret', Authorization: 'Bearer abc' },
      },
      auth: { type: 'none' },
      schemaVersion: 1,
      createdAt: 5,
      updatedAt: 6,
    },
  ];

  it('split 把 bearer token 抽到 secret，safe 中清空但保留 bearer 类型', () => {
    const { safe, secret } = splitMcpTokens(servers);

    expect(secret['srv-bearer']).toEqual({ token: 'super-secret' });

    const safeBearer = safe.find((s) => s.id === 'srv-bearer')!;
    expect(safeBearer.auth).toEqual({ type: 'bearer', token: '' });

    const safeNone = safe.find((s) => s.id === 'srv-none')!;
    expect(safeNone.auth).toEqual({ type: 'none' });
  });

  it('split 把自定义 transport.headers 整体抽到 secret，safe 中移除', () => {
    const { safe, secret } = splitMcpTokens(servers);

    expect(secret['srv-headers']).toEqual({
      headers: { 'X-Api-Key': 'header-secret', Authorization: 'Bearer abc' },
    });

    const safeHeaders = safe.find((s) => s.id === 'srv-headers')!;
    expect(safeHeaders.transport.headers).toBeUndefined();
  });

  it('safe 中不残留任何明文密钥（token 或 header）', () => {
    const { safe } = splitMcpTokens(servers);
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('header-secret');
    expect(serialized).not.toContain('Bearer abc');
  });

  it('split 不修改入参、返回的对象不与入参共享引用', () => {
    const { safe } = splitMcpTokens(servers);
    // 入参未被修改。
    const bearer = servers.find((s) => s.id === 'srv-bearer')!;
    expect(bearer.auth).toEqual({ type: 'bearer', token: 'super-secret' });
    const headers = servers.find((s) => s.id === 'srv-headers')!;
    expect(headers.transport.headers).toEqual({
      'X-Api-Key': 'header-secret',
      Authorization: 'Bearer abc',
    });
    // 返回对象是新引用。
    expect(safe[0]).not.toBe(servers[0]);
  });

  it('split → restoreSecret(replace) 往返还原出原始配置', () => {
    const { safe, secret } = splitMcpTokens(servers);
    // restoreSecret 作用于本地完整值；这里用 safe（token 空 / 无 headers）模拟
    // 「先恢复 settings safe、再恢复密钥」的两步流程。
    const restored = restoreMcpSecrets(safe, secret, 'replace');
    expect(restored).toEqual(servers);
  });

  it('restoreSecret(merge) 仅补本地缺失的密钥，本地已有则保留', () => {
    const { secret } = splitMcpTokens(servers);
    // 本地 srv-bearer 已有一个有效 token，不应被备份覆盖。
    const local: MCPServerConfig[] = [
      { ...servers[1], auth: { type: 'bearer', token: 'local-live-token' } },
      // srv-headers 本地无 headers，应被补入。
      { ...servers[2], transport: { type: 'streamable-http', url: 'https://c.example/mcp' } },
    ];
    const restored = restoreMcpSecrets(local, secret, 'merge');
    const bearer = restored.find((s) => s.id === 'srv-bearer')!;
    expect(bearer.auth).toEqual({ type: 'bearer', token: 'local-live-token' });
    const headers = restored.find((s) => s.id === 'srv-headers')!;
    expect(headers.transport.headers).toEqual({
      'X-Api-Key': 'header-secret',
      Authorization: 'Bearer abc',
    });
  });

  it('restoreSecret 不新增本地不存在的 server（secret 不携带完整配置）', () => {
    const { secret } = splitMcpTokens(servers);
    // 本地只有 srv-bearer；secret 里的 srv-headers 不应被凭空变出来。
    const local: MCPServerConfig[] = [
      { ...servers[1], auth: { type: 'bearer', token: '' } },
    ];
    const restored = restoreMcpSecrets(local, secret, 'replace');
    expect(restored).toHaveLength(1);
    expect(restored[0].id).toBe('srv-bearer');
  });

  it('restoreSecret 不修改入参', () => {
    const { safe, secret } = splitMcpTokens(servers);
    const snapshot = JSON.stringify(safe);
    restoreMcpSecrets(safe, secret, 'replace');
    expect(JSON.stringify(safe)).toBe(snapshot);
  });
});

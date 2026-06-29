import { describe, it, expect } from 'vitest';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import {
  packArchive,
  unpackArchive,
  readManifest,
  BackupArchiveError,
  type BackupBundle,
} from '@/lib/backup/archive';
import { BACKUP_FORMAT_VERSION, type BackupManifest } from '@/lib/backup/types';

const enc = new TextEncoder();

function baseManifest(): BackupManifest {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    app: 'cebian',
    appVersion: '1.3.2',
    createdAt: 1_749_300_600_000,
    name: 'Backup test',
    description: '',
    encrypted: false,
    categories: {
      sessions: { included: true, count: 1, workspaces: false },
      settings: { included: true },
      credentials: { included: false },
      skillsPrompts: { included: true, fileCount: 1 },
      memories: { included: false },
    },
  };
}

function sampleBundle(): BackupBundle {
  return {
    manifest: baseManifest(),
    files: {
      'config.json': enc.encode('{"theme":"system"}'),
      'sessions/6f9619ff-8b86-d011-b42d-00cf4fc964ff.json': enc.encode('{"id":"s1"}'),
      // vfs 里放一个二进制文件，验证字节精确往返。
      'vfs/home/user/.cebian/skills/foo/icon.bin': new Uint8Array([0, 1, 2, 253, 254, 255]),
    },
  };
}

describe('archive 未加密往返', () => {
  it('pack → unpack 还原 manifest 与全部文件', async () => {
    const bundle = sampleBundle();
    const zip = await packArchive(bundle);
    const out = await unpackArchive(zip);

    expect(out.manifest.encrypted).toBe(false);
    expect(out.manifest.name).toBe('Backup test');
    expect(Object.keys(out.files).sort()).toEqual(Object.keys(bundle.files).sort());
    for (const [path, bytes] of Object.entries(bundle.files)) {
      expect(out.files[path]).toEqual(bytes);
    }
  });

  it('未加密包不含 encryption 字段、payload 文件落在 payload/ 下', async () => {
    const zip = await packArchive(sampleBundle());
    const manifest = readManifest(zip);
    expect(manifest.encrypted).toBe(false);
    expect(manifest.encryption).toBeUndefined();
    // 直接检查外层 zip 结构：manifest.json 在根，payload 文件带 payload/ 前缀，
    // 根目录不存在裸 config.json。
    const entries = unzipSync(zip);
    expect(Object.keys(entries)).toContain('manifest.json');
    expect(Object.keys(entries)).toContain('payload/config.json');
    expect(Object.keys(entries)).toContain('payload/sessions/6f9619ff-8b86-d011-b42d-00cf4fc964ff.json');
    expect(Object.keys(entries)).not.toContain('config.json');
  });

  it('二进制文件字节精确往返', async () => {
    const zip = await packArchive(sampleBundle());
    const out = await unpackArchive(zip);
    expect(out.files['vfs/home/user/.cebian/skills/foo/icon.bin']).toEqual(
      new Uint8Array([0, 1, 2, 253, 254, 255]),
    );
  });
});

describe('archive 加密往返', () => {
  it('pack(password) → unpack(password) 还原全部文件', async () => {
    const bundle = sampleBundle();
    const zip = await packArchive(bundle, 'pw');
    const out = await unpackArchive(zip, 'pw');

    expect(out.manifest.encrypted).toBe(true);
    for (const [path, bytes] of Object.entries(bundle.files)) {
      expect(out.files[path]).toEqual(bytes);
    }
  });

  it('packArchive 敲定加密状态：传 password 则 manifest.encrypted=true + encryption meta', async () => {
    // 入参 manifest.encrypted 故意设为 false，验证 packArchive 覆盖它。
    const zip = await packArchive(sampleBundle(), 'pw');
    const manifest = readManifest(zip);
    expect(manifest.encrypted).toBe(true);
    expect(manifest.encryption?.algo).toBe('AES-GCM');
    expect(manifest.encryption?.salt.length).toBeGreaterThan(0);
  });

  it('readManifest 不需要口令即可读出加密包的明文元信息', async () => {
    const zip = await packArchive(sampleBundle(), 'pw');
    const manifest = readManifest(zip);
    expect(manifest.name).toBe('Backup test');
    expect(manifest.categories.sessions.count).toBe(1);
  });

  it('加密包的明文区不泄漏 payload 内容', async () => {
    const bundle: BackupBundle = {
      manifest: baseManifest(),
      files: { 'credentials.json': enc.encode('sk-secret-token') },
    };
    const zip = await packArchive(bundle, 'pw');
    // 整个外层 zip 字节里不应出现明文 secret。
    const needle = enc.encode('sk-secret-token');
    expect(bytesInclude(zip, needle)).toBe(false);
  });

  it('加密包缺口令 → passwordRequired', async () => {
    const zip = await packArchive(sampleBundle(), 'pw');
    await expect(unpackArchive(zip)).rejects.toMatchObject({ code: 'passwordRequired' });
  });

  it('加密包口令错误 → wrongPassword', async () => {
    const zip = await packArchive(sampleBundle(), 'right');
    await expect(unpackArchive(zip, 'wrong')).rejects.toMatchObject({ code: 'wrongPassword' });
  });
});

describe('archive 错误与安全', () => {
  it('非 zip 字节 → invalid', async () => {
    await expect(unpackArchive(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('缺 manifest.json → invalid', async () => {
    const zip = zipSync({ 'config.json': strToU8('{}') });
    await expect(unpackArchive(zip)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('payload 含可逃逸路径（zip-slip）→ unsafePath', async () => {
    const manifest = baseManifest();
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'payload/../escape.txt': strToU8('evil'),
    });
    await expect(unpackArchive(zip)).rejects.toMatchObject({ code: 'unsafePath' });
  });

  it('payload/ 之外的杂项条目 → invalid（容器不变量）', async () => {
    const manifest = baseManifest();
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'stray.txt': strToU8('outside payload'),
    });
    await expect(unpackArchive(zip)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('丢弃垃圾条目（__MACOSX / .DS_Store）', async () => {
    const manifest = baseManifest();
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest)),
      'payload/config.json': strToU8('{}'),
      '__MACOSX/foo': strToU8('junk'),
      '.DS_Store': strToU8('junk'),
    });
    const out = await unpackArchive(zip);
    expect(Object.keys(out.files)).toEqual(['config.json']);
  });

  it('BackupArchiveError 是具名错误类', async () => {
    try {
      await unpackArchive(new Uint8Array([9, 9, 9]));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BackupArchiveError);
    }
  });
});

describe('archive manifest 结构校验', () => {
  it('缺 categories 的 manifest → invalid', async () => {
    const m = { ...baseManifest() } as Record<string, unknown>;
    delete m.categories;
    const zip = zipSync({ 'manifest.json': strToU8(JSON.stringify(m)) });
    await expect(unpackArchive(zip)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('旧备份缺 categories.memories → 兼容补成 included:false（不报错）', async () => {
    const m = baseManifest() as unknown as Record<string, unknown>;
    delete (m.categories as Record<string, unknown>).memories;
    const zip = zipSync({ 'manifest.json': strToU8(JSON.stringify(m)) });
    const manifest = readManifest(zip);
    expect(manifest.categories.memories).toEqual({ included: false });
  });

  it('加密标记但 encryption 为空对象 → invalid（而非 wrongPassword）', async () => {
    const m = { ...baseManifest(), encrypted: true, encryption: {} };
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify(m)),
      'payload.enc': new Uint8Array([1, 2, 3]),
    });
    await expect(unpackArchive(zip, 'pw')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('加密包外层混入额外明文条目 → invalid（容器不变量）', async () => {
    // 先生成一个合法加密包，再往外层塞一个明文 config.json。
    const validZip = await packArchive(sampleBundle(), 'pw');
    const entries = unzipSync(validZip);
    entries['config.json'] = strToU8('{"leak":true}');
    const tampered = zipSync(entries);
    await expect(unpackArchive(tampered, 'pw')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('未加密包根级混入 payload.enc → invalid（伪装的加密残留）', async () => {
    const m = baseManifest();
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify(m)),
      'payload/config.json': strToU8('{}'),
      'payload.enc': new Uint8Array([1, 2, 3]),
    });
    await expect(unpackArchive(zip)).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('archive payload 内的真实垃圾文件名', () => {
  it('VFS 里名为 .DS_Store / Thumbs.db 的真实文件能往返（不被误删）', async () => {
    const bundle: BackupBundle = {
      manifest: baseManifest(),
      files: {
        'vfs/workspaces/s1/.DS_Store': enc.encode('real-data-1'),
        'vfs/home/user/.cebian/skills/foo/Thumbs.db': enc.encode('real-data-2'),
      },
    };
    const zip = await packArchive(bundle);
    const out = await unpackArchive(zip);
    expect(out.files['vfs/workspaces/s1/.DS_Store']).toEqual(enc.encode('real-data-1'));
    expect(out.files['vfs/home/user/.cebian/skills/foo/Thumbs.db']).toEqual(
      enc.encode('real-data-2'),
    );
  });
});

describe('archive 打包入参校验', () => {
  it('payload 文件名为 manifest.json 也能正常往返（payload/ 前缀隔离）', async () => {
    // 未来 workspace 跑 React 应用时，VFS 里完全可能有 manifest.json。
    const bundle: BackupBundle = {
      manifest: baseManifest(),
      files: { 'vfs/workspaces/s1/manifest.json': enc.encode('{"react":true}') },
    };
    const zip = await packArchive(bundle);
    const out = await unpackArchive(zip);
    expect(out.files['vfs/workspaces/s1/manifest.json']).toEqual(enc.encode('{"react":true}'));
    // 容器自己的 manifest.json 不受影响。
    expect(out.manifest.name).toBe('Backup test');
  });

  it('payload 含可逃逸路径 → unsafePath（pack 阶段就拒绝）', async () => {
    const bundle: BackupBundle = {
      manifest: baseManifest(),
      files: { '../escape.txt': enc.encode('evil') },
    };
    await expect(packArchive(bundle)).rejects.toMatchObject({ code: 'unsafePath' });
  });
});

/** 在 Uint8Array 中查找子序列。 */
function bytesInclude(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

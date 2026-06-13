import { describe, it, expect } from 'vitest';
import { isSafeSnapshotName, assertValidBaseUrl, WebDavError } from '@/lib/backup/webdav';

// 仅覆盖路径安全谓词（纯逻辑、无 DOM）。parseSnapshotList 依赖 DOMParser，留待手动 /
// 集成测试，不在 node 环境单测。
describe('isSafeSnapshotName', () => {
  it('接受正常的 .zip 文件名', () => {
    expect(isSafeSnapshotName('cebian-backup-2026-06-07-1430.zip')).toBe(true);
    expect(isSafeSnapshotName('a.ZIP')).toBe(true);
  });

  it('拒绝路径穿越与多段路径', () => {
    expect(isSafeSnapshotName('../outside.zip')).toBe(false);
    expect(isSafeSnapshotName('a/b.zip')).toBe(false);
    expect(isSafeSnapshotName('a\\b.zip')).toBe(false);
    expect(isSafeSnapshotName('..')).toBe(false);
    expect(isSafeSnapshotName('.')).toBe(false);
  });

  it('拒绝控制符与空名', () => {
    expect(isSafeSnapshotName('')).toBe(false);
    expect(isSafeSnapshotName('bad\u0000.zip')).toBe(false);
    expect(isSafeSnapshotName('bad\n.zip')).toBe(false);
  });

  it('拒绝非 .zip 文件（含目录条目）', () => {
    expect(isSafeSnapshotName('notes.txt')).toBe(false);
    expect(isSafeSnapshotName('subdir')).toBe(false);
    expect(isSafeSnapshotName('archive.zip.bak')).toBe(false);
  });
});

describe('assertValidBaseUrl', () => {
  it('接受干净的 http(s) 绝对地址', () => {
    expect(() => assertValidBaseUrl('https://dav.example.com/remote.php/dav')).not.toThrow();
    expect(() => assertValidBaseUrl('http://localhost:8080/dav')).not.toThrow();
  });

  it('拒绝非绝对 / 非 http(s) 地址', () => {
    expect(() => assertValidBaseUrl('dav.example.com')).toThrow(WebDavError);
    expect(() => assertValidBaseUrl('ftp://example.com')).toThrow(WebDavError);
    expect(() => assertValidBaseUrl('not a url')).toThrow(WebDavError);
  });

  it('拒绝内嵌账号密码的 URL（凭据应走独立字段，避免泄露）', () => {
    expect(() => assertValidBaseUrl('https://user:pass@example.com/dav')).toThrow(WebDavError);
    expect(() => assertValidBaseUrl('https://user@example.com/dav')).toThrow(WebDavError);
  });

  it('拒绝带 query / fragment 的 URL（拼目录会产生错误目标）', () => {
    expect(() => assertValidBaseUrl('https://example.com/dav?token=x')).toThrow(WebDavError);
    expect(() => assertValidBaseUrl('https://example.com/dav#frag')).toThrow(WebDavError);
    // 空 query / fragment 分隔符也要拒（parsed.search/hash 是空串，但裸 ? / # 仍坏拼接）。
    expect(() => assertValidBaseUrl('https://example.com/dav?')).toThrow(WebDavError);
    expect(() => assertValidBaseUrl('https://example.com/dav#')).toThrow(WebDavError);
  });

  it('编码后的 %3F / %23 不算分隔符，可接受', () => {
    expect(() => assertValidBaseUrl('https://example.com/dav%3Fkeep')).not.toThrow();
  });

  it('抛出的错误码是 invalid', () => {
    try {
      assertValidBaseUrl('https://user:pass@example.com');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WebDavError);
      expect((err as WebDavError).code).toBe('invalid');
    }
  });
});

import { describe, it, expect } from 'vitest';
import {
  parseBgFetchPatterns,
  matchUrl,
  formatMatchPattern,
  type MatchPattern,
} from '@/lib/tools/url-pattern';

describe('parseBgFetchPatterns — 从 permissions 抽取 bgFetch pattern', () => {
  it('没有任何 bgFetch 权限 → null', () => {
    expect(parseBgFetchPatterns([])).toBeNull();
    expect(parseBgFetchPatterns(['vfs.read', 'chrome.cookies'])).toBeNull();
  });

  it('裸 bgFetch → 等价 *://*/* （匹配任意 http(s) URL）', () => {
    const patterns = parseBgFetchPatterns(['bgFetch']);
    expect(patterns).not.toBeNull();
    expect(patterns!.length).toBe(1);
    expect(matchUrl(new URL('https://example.com/foo'), patterns![0])).toBe(true);
    expect(matchUrl(new URL('http://any.host/'), patterns![0])).toBe(true);
  });

  it('bgFetch:<pattern> → 按 match-pattern 限定', () => {
    const patterns = parseBgFetchPatterns(['bgFetch:https://api.example.com/*']);
    expect(patterns!.length).toBe(1);
    expect(matchUrl(new URL('https://api.example.com/v1/data'), patterns![0])).toBe(true);
    expect(matchUrl(new URL('https://evil.com/'), patterns![0])).toBe(false);
  });

  it('多条 bgFetch 权限按声明顺序累积，忽略非 bgFetch token', () => {
    const patterns = parseBgFetchPatterns([
      'vfs.write',
      'bgFetch:https://a.com/*',
      'chrome.tabs',
      'bgFetch:https://b.com/*',
    ]);
    expect(patterns!.map(formatMatchPattern)).toEqual([
      'https://a.com/*',
      'https://b.com/*',
    ]);
  });

  it('malformed 空 bgFetch: → 被当作无效 token 跳过（不暴露 bgFetch）', () => {
    // parsePermission('bgFetch:') 返回 null，因此整条权限集没有有效 bgFetch。
    expect(parseBgFetchPatterns(['bgFetch:'])).toBeNull();
  });

  it('非空但非法的 pattern → 抛错，错误消息含原始权限串', () => {
    expect(() => parseBgFetchPatterns(['bgFetch:ftp://example.com/*'])).toThrow(
      /Invalid bgFetch permission "bgFetch:ftp:\/\/example\.com\/\*"/,
    );
  });
});

describe('parseBgFetchPatterns — 返回形态', () => {
  it('返回的是 MatchPattern 数组', () => {
    const patterns = parseBgFetchPatterns(['bgFetch']);
    const p: MatchPattern = patterns![0];
    expect(p.scheme).toBe('*');
  });
});

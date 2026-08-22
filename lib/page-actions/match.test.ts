import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isUnrestrictedPageScope,
  matchesAnyPagePattern,
  matchesPageScope,
  resolvePageScope,
  validatePagePattern,
} from '@/lib/page-actions/match';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('validatePagePattern', () => {
  it('合法 pattern → null', () => {
    expect(validatePagePattern('*://*.example.com/*')).toBeNull();
    expect(validatePagePattern('https://mail.google.com/mail/*')).toBeNull();
    expect(validatePagePattern('<all_urls>')).toBeNull();
  });

  it('非法 pattern → 返回错误消息而非抛错', () => {
    expect(validatePagePattern('example.com')).toMatch(/malformed pattern/);
    expect(validatePagePattern('ftp://example.com/*')).toMatch(/unsupported scheme/);
    expect(validatePagePattern('')).toMatch(/malformed pattern/);
  });
});

describe('matchesAnyPagePattern', () => {
  it('空列表 → false（无规则即不命中）', () => {
    expect(matchesAnyPagePattern('https://example.com/', [])).toBe(false);
  });

  it('命中任意一条即 true', () => {
    const patterns = ['https://a.com/*', '*://*.b.com/*'];
    expect(matchesAnyPagePattern('https://a.com/x', patterns)).toBe(true);
    expect(matchesAnyPagePattern('http://sub.b.com/y', patterns)).toBe(true);
    expect(matchesAnyPagePattern('https://c.com/', patterns)).toBe(false);
  });

  it('`*.foo.com` 也命中根域（沿用 Chrome 约定）', () => {
    expect(matchesAnyPagePattern('https://foo.com/', ['*://*.foo.com/*'])).toBe(true);
  });

  it('path 之外的 query 不参与匹配', () => {
    // url-pattern 只匹配 pathname，故 pattern 写到 path 结尾即可命中带 query 的 URL。
    expect(matchesAnyPagePattern('https://x.com/watch?v=1', ['https://x.com/watch'])).toBe(true);
    // 反之 pattern 里写 query 会被当成 path 的字面量 → 不命中。
    expect(matchesAnyPagePattern('https://x.com/watch?v=1', ['https://x.com/watch?v=1'])).toBe(
      false,
    );
  });

  it('scheme `*` 只覆盖 http/https，不匹配其它协议', () => {
    expect(matchesAnyPagePattern('file:///tmp/a.html', ['*://*/*'])).toBe(false);
  });

  it('坏 pattern 跳过并 warn，同列表里的好 pattern 仍生效', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(matchesAnyPagePattern('https://good.com/', ['not-a-pattern', 'https://good.com/*'])).toBe(
      true,
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('全是坏 pattern → false，不抛错', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(matchesAnyPagePattern('https://good.com/', ['nope', 'ftp://x/*'])).toBe(false);
  });

  it('URL 本身不可解析 → false', () => {
    expect(matchesAnyPagePattern('', ['<all_urls>'])).toBe(false);
    expect(matchesAnyPagePattern('not a url', ['<all_urls>'])).toBe(false);
  });
});

describe('matchesPageScope', () => {
  const scope = (include: string[] = [], exclude: string[] = []) => ({ include, exclude });

  it('两个列表都空 = 所有页面生效', () => {
    expect(matchesPageScope('https://example.com/', scope())).toBe(true);
  });

  it('只配 include = 白名单', () => {
    const s = scope(['https://example.com/*']);
    expect(matchesPageScope('https://example.com/x', s)).toBe(true);
    expect(matchesPageScope('https://other.com/', s)).toBe(false);
  });

  it('只配 exclude = 黑名单', () => {
    const s = scope([], ['https://example.com/*']);
    expect(matchesPageScope('https://example.com/x', s)).toBe(false);
    expect(matchesPageScope('https://other.com/', s)).toBe(true);
  });

  it('exclude 优先于 include', () => {
    const s = scope(['https://example.com/*'], ['https://example.com/docs/*']);
    expect(matchesPageScope('https://example.com/blog', s)).toBe(true);
    expect(matchesPageScope('https://example.com/docs/intro', s)).toBe(false);
  });

  it('exclude 命中但 include 不命中 → 依然不生效（两条都不满足）', () => {
    const s = scope(['https://a.com/*'], ['https://b.com/*']);
    expect(matchesPageScope('https://b.com/x', s)).toBe(false);
    expect(matchesPageScope('https://c.com/x', s)).toBe(false);
  });
});

describe('resolvePageScope / isUnrestrictedPageScope', () => {
  it('缺省补齐成两个空列表，且是复制而非共享引用', () => {
    expect(resolvePageScope(undefined)).toEqual({ include: [], exclude: [] });
    const include = ['https://a.com/*'];
    const resolved = resolvePageScope({ include });
    expect(resolved.exclude).toEqual([]);
    expect(resolved.include).not.toBe(include);
  });

  it('两个列表都空才算「没做限制」', () => {
    expect(isUnrestrictedPageScope({ include: [], exclude: [] })).toBe(true);
    expect(isUnrestrictedPageScope({ include: ['https://a.com/*'], exclude: [] })).toBe(false);
    expect(isUnrestrictedPageScope({ include: [], exclude: ['https://a.com/*'] })).toBe(false);
  });
});

describe('resolvePageScope — 兼容未发布的旧形状', () => {
  it('裸数组按 include 解析（旧动作配置里数组就是「仅在这些页面」）', () => {
    expect(resolvePageScope(['https://a.com/*'])).toEqual({
      include: ['https://a.com/*'],
      exclude: [],
    });
  });

  it('裸数组也是复制，不与入参共享引用', () => {
    const legacy = ['https://a.com/*'];
    expect(resolvePageScope(legacy).include).not.toBe(legacy);
  });
});

import { describe, expect, it } from 'vitest';
import {
  HIGHLIGHT_MAX_BYTES,
  HIGHLIGHT_MAX_LINES,
  highlightCode,
  languageName,
} from '@/entrypoints/vfs/lib/highlight';
import { CODE_LANG } from '@/entrypoints/vfs/lib/path-utils';

const small = { lines: 1, bytes: 10 };

describe('highlight · 注册表守卫', () => {
  it('CODE_LANG 里的每个语言 id 都已注册（否则该扩展名会静默退回纯文本）', () => {
    const missing = [...new Set(Object.values(CODE_LANG))].filter(
      (lang) => highlightCode('x', lang, small) === null,
    );
    expect(missing).toEqual([]);
  });

  it('markdown 源码态用的 `markdown` 也已注册', () => {
    expect(highlightCode('# 标题', 'markdown', small)).toContain('hljs-section');
  });
});

describe('highlight · 输出安全边界', () => {
  const hostile = '<script>alert(1)</script><img src=x onerror="alert(2)">';

  it.each(['xml', 'javascript', 'markdown', 'plaintext'])('%s：用户文本全部转义，只剩 hljs 自己的标签', (lang) => {
    const html = highlightCode(hostile, lang, small);
    expect(html).not.toBeNull();
    // 去掉 highlight.js 生成的 <span ...> / </span> 后，不应再有任何 `<`。
    const stripped = html!.replace(/<span class="[^"]*">|<\/span>/g, '');
    expect(stripped).not.toContain('<');
    // 转义后的 `&lt;img ... onerror=...&gt;` 只是文本，不构成属性；有 `<` 才有攻击面。
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
  });
});

describe('highlight · 阈值与降级', () => {
  it('行数或字节数超阈值返回 null；恰好等于阈值仍高亮', () => {
    expect(highlightCode('x', 'typescript', { lines: HIGHLIGHT_MAX_LINES + 1, bytes: 1 })).toBeNull();
    expect(highlightCode('x', 'typescript', { lines: 1, bytes: HIGHLIGHT_MAX_BYTES + 1 })).toBeNull();
    expect(highlightCode('x', 'typescript', { lines: HIGHLIGHT_MAX_LINES, bytes: HIGHLIGHT_MAX_BYTES })).not.toBeNull();
  });

  it('未注册的语言返回 null', () => {
    expect(highlightCode('fn main() {}', 'zig', small)).toBeNull();
  });
});

describe('highlight · 显示名', () => {
  it('常规语言取 hljs 的名字，不适合页头的几个被覆盖，未注册的回落为 id', () => {
    expect(languageName('typescript')).toBe('TypeScript');
    expect(languageName('cpp')).toBe('C++');
    expect(languageName('xml')).toBe('XML');
    expect(languageName('ini')).toBe('INI');
    expect(languageName('php')).toBe('PHP');
    expect(languageName('zig')).toBe('zig');
  });
});

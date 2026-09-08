import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createWebSearchTool, formatAllFailed, formatSearchResults, type EngineAttempt } from '@/lib/tools/web-search';
import type { ResolvedSearchEngine } from '@/lib/search/engines';

function engine(id: string, over: Partial<ResolvedSearchEngine> = {}): ResolvedSearchEngine {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    kind: 'builtin',
    enabled: true,
    urlTemplate: `https://${id}.test/?q={query}`,
    extract: 'function extract() { return { status: "ok", results: [] }; }',
    modified: false,
    ...over,
  };
}

const attempt = (id: string, status: EngineAttempt['status'], reason?: string): EngineAttempt => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  status,
  ...(reason ? { reason } : {}),
  ms: 1,
});

beforeEach(() => {
  fakeBrowser.reset();
});

describe('formatSearchResults', () => {
  it('标题行带引擎名与原 query，条目为「编号 + 粗体标题 / URL / 摘要」，无摘要则省第三行', () => {
    const text = formatSearchResults(
      'Bing',
      'cebian extension',
      [
        { title: 'Cebian', url: 'https://cebian.app/', snippet: 'AI in your browser' },
        { title: 'GitHub', url: 'https://github.com/maotoumao/Cebian' },
      ],
      [],
    );
    expect(text).toBe(
      [
        'Search results from Bing for "cebian extension":',
        '',
        '1. **Cebian**',
        '   https://cebian.app/',
        '   AI in your browser',
        '2. **GitHub**',
        '   https://github.com/maotoumao/Cebian',
      ].join('\n'),
    );
  });

  it('之前失败过的引擎只在有的时候追加一行', () => {
    const text = formatSearchResults('Brave', 'q', [{ title: 't', url: 'https://a.test/' }], [
      attempt('bing', 'blocked'),
      attempt('google', 'failed', 'navigation failed: timeout'),
    ]);
    expect(text.endsWith(
      'Earlier engine attempts: Bing — blocked (CAPTCHA or access interstitial); Google — failed (navigation failed: timeout).',
    )).toBe(true);
  });
});

describe('formatAllFailed', () => {
  it('逐引擎列出结局，区分 no results / empty / blocked / failed / skipped，并给出下一步建议', () => {
    const text = formatAllFailed('q', [
      attempt('bing', 'no-results'),
      attempt('brave', 'empty', 'still missing after 5s of retries'),
      attempt('google', 'blocked'),
      attempt('duckduckgo', 'failed', 'extract() timed out after 10s'),
      attempt('baidu', 'skipped', 'tool time budget exhausted'),
    ]);
    expect(text).toContain('No usable search results were retrieved for "q". Engine outcomes:');
    expect(text).toContain('- Bing — no results');
    expect(text).toContain('- Brave — results container did not appear (still missing after 5s of retries)');
    expect(text).toContain('- Google — blocked (CAPTCHA or access interstitial)');
    expect(text).toContain('- Duckduckgo — failed (extract() timed out after 10s)');
    expect(text).toContain('- Baidu — skipped (tool time budget exhausted)');
    expect(text).toContain('Settings → Chat → Web search');
  });
});

describe('createWebSearchTool', () => {
  it('零引擎：描述指向设置页，调用即抛可操作错误，不碰标签页', async () => {
    const create = vi.spyOn(fakeBrowser.tabs, 'create');
    const tool = createWebSearchTool([]);
    expect(tool.name).toBe('web_search');
    expect(tool.description).toContain('No search engines are enabled');
    await expect(tool.execute('c1', { query: 'x' }, undefined)).rejects.toThrow(/Settings → Chat → Web search/);
    expect(create).not.toHaveBeenCalled();
  });

  it('描述按顺序列出启用引擎，带适用场景提示', () => {
    const tool = createWebSearchTool([engine('bing'), engine('baidu', { when: 'Chinese queries' })]);
    expect(tool.description).toContain('Enabled engines in fallback order: bing (Bing), baidu (Baidu; Chinese queries).');
  });

  it('空白 query / 未知 engine → 抛错且不碰标签页', async () => {
    const create = vi.spyOn(fakeBrowser.tabs, 'create');
    const tool = createWebSearchTool([engine('bing'), engine('brave')]);
    await expect(tool.execute('c1', { query: '   ' }, undefined)).rejects.toThrow('"query" must not be empty.');
    await expect(tool.execute('c2', { query: 'x', engine: 'kagi' }, undefined)).rejects.toThrow(
      'Unknown search engine "kagi". Enabled engines: bing, brave',
    );
    expect(create).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from 'vitest';
import {
  buildSearchUrl,
  enabledSearchEngines,
  findSearchEngine,
  isSearchEngineHost,
  listSearchEngineIds,
  listSearchEngines,
  preferSearchEngine,
  searchEngineHost,
  validateUrlTemplate,
  type ResolvedSearchEngine,
} from '@/lib/search/engines';
import type { CustomSearchEngine, SearchEnginesConfig } from '@/lib/search/types';

vi.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
}));

function config(over: Partial<SearchEnginesConfig> = {}): SearchEnginesConfig {
  return { builtin: {}, custom: [], ...over };
}

function customEngine(over: Partial<CustomSearchEngine> = {}): CustomSearchEngine {
  return {
    id: 'custom-aaaaaaaaaaaa',
    name: 'Kagi',
    urlTemplate: 'https://kagi.com/search?q={query}',
    extract: 'function extract() { return { status: "ok", results: [] }; }',
    ...over,
  };
}

function engine(id: string, urlTemplate: string): ResolvedSearchEngine {
  return { id, name: id, kind: 'custom', enabled: true, urlTemplate, extract: '', modified: false };
}

describe('buildSearchUrl', () => {
  it('把搜索词 URL 编码后填进占位符：空格 / & / + / # / 引号 / 中文 / C++ 都不会破坏地址', () => {
    const url = buildSearchUrl('https://www.bing.com/search?q={query}', 'a b & c+d #e "f" 中文 C++');
    expect(url).toBe(
      'https://www.bing.com/search?q=a%20b%20%26%20c%2Bd%20%23e%20%22f%22%20%E4%B8%AD%E6%96%87%20C%2B%2B',
    );
    expect(new URL(url).searchParams.get('q')).toBe('a b & c+d #e "f" 中文 C++');
  });

  it('模板里出现多次占位符全部替换', () => {
    expect(buildSearchUrl('https://x.test/{query}?q={query}', 'hi')).toBe('https://x.test/hi?q=hi');
  });

  it('模板缺占位符 → 抛错', () => {
    expect(() => buildSearchUrl('https://x.test/search', 'hi')).toThrow(/\{query\}/);
  });
});

describe('validateUrlTemplate / searchEngineHost', () => {
  it('合法模板 → null；缺占位符 / 非 http(s) / 畸形地址各给出对应问题', () => {
    expect(validateUrlTemplate('https://kagi.com/search?q={query}')).toBeNull();
    expect(validateUrlTemplate('https://kagi.com/search?q=')).toBe('missingPlaceholder');
    expect(validateUrlTemplate('ftp://kagi.com/{query}')).toBe('invalidUrl');
    expect(validateUrlTemplate('not a url {query}')).toBe('invalidUrl');
  });

  it('host 小写并去掉前缀 www.', () => {
    expect(searchEngineHost('https://WWW.Bing.com/search?q={query}')).toBe('bing.com');
    expect(searchEngineHost('https://html.duckduckgo.com/html/?q={query}')).toBe('html.duckduckgo.com');
  });
});

describe('isSearchEngineHost', () => {
  const engines = [
    engine('bing', 'https://www.bing.com/search?q={query}'),
    engine('google', 'https://www.google.com/search?q={query}'),
  ];

  it('本域、带 www. 的本域与子域都算我们的搜索页', () => {
    expect(isSearchEngineHost('https://www.bing.com/search?q=a', engines)).toBe(true);
    expect(isSearchEngineHost('https://bing.com/', engines)).toBe(true);
    expect(isSearchEngineHost('https://cn.bing.com/search?q=a', engines)).toBe(true);
    expect(isSearchEngineHost('https://consent.google.com/m?continue=x', engines)).toBe(true);
  });

  it('其它站点、貌似相近的域名、非 http(s) 与畸形地址都不算', () => {
    expect(isSearchEngineHost('https://notbing.com/', engines)).toBe(false);
    expect(isSearchEngineHost('https://example.com/bing.com', engines)).toBe(false);
    expect(isSearchEngineHost('chrome://newtab', engines)).toBe(false);
    expect(isSearchEngineHost('not a url', engines)).toBe(false);
  });
});

describe('listSearchEngineIds / listSearchEngines', () => {
  it('缺省顺序：内置在前（bing → brave → google → duckduckgo → baidu），自定义按数组序补后', () => {
    const ids = listSearchEngineIds(config({ custom: [customEngine()] }));
    expect(ids).toEqual(['bing', 'brave', 'google', 'duckduckgo', 'baidu', 'custom-aaaaaaaaaaaa']);
  });

  it('order 里认得的 id 在前，未列出的按缺省补后，不存在 / 重复的 id 忽略', () => {
    const ids = listSearchEngineIds(
      config({ custom: [customEngine()], order: ['google', 'ghost', 'google', 'custom-aaaaaaaaaaaa'] }),
    );
    expect(ids).toEqual(['google', 'custom-aaaaaaaaaaaa', 'bing', 'brave', 'duckduckgo', 'baidu']);
  });

  it('非法 id、与内置重名、重复的自定义引擎在边界丢弃', () => {
    const ids = listSearchEngineIds(
      config({
        custom: [
          customEngine({ id: '__proto__' }),
          customEngine({ id: 'bing' }),
          customEngine({ id: 'custom-aaaaaaaaaaaa' }),
          customEngine({ id: 'custom-aaaaaaaaaaaa', name: 'dup' }),
        ],
      }),
    );
    expect(ids.filter((id) => id.startsWith('custom-'))).toEqual(['custom-aaaaaaaaaaaa']);
    expect(ids).not.toContain('__proto__');
  });

  it('内置引擎合并覆盖层：改过地址 / 脚本 / 适用场景才算 modified，单独停用不算', () => {
    const list = listSearchEngines(
      config({
        builtin: {
          bing: { enabled: false },
          google: { urlTemplate: 'https://www.google.com.hk/search?q={query}' },
          baidu: { when: '' },
        },
      }),
    );
    const byId = Object.fromEntries(list.map((e) => [e.id, e]));
    expect(byId.bing.enabled).toBe(false);
    expect(byId.bing.modified).toBe(false);
    expect(byId.google.urlTemplate).toBe('https://www.google.com.hk/search?q={query}');
    expect(byId.google.modified).toBe(true);
    // 用户把百度的适用场景清空：覆盖层存空串，解析后 when 不带出来，但算已修改。
    expect(byId.baidu.when).toBeUndefined();
    expect(byId.baidu.modified).toBe(true);
    // 内置名走 i18n；默认适用场景也走 i18n。
    expect(byId.bing.name).toBe('settings.chat.search.engines.bing.name');
    expect(findSearchEngine(config(), 'baidu')?.when).toBe('settings.chat.search.engines.baidu.when');
  });

  it('enabledSearchEngines 只留启用的，保持顺序', () => {
    const enabled = enabledSearchEngines(
      config({ builtin: { bing: { enabled: false } }, custom: [customEngine({ enabled: false })] }),
    );
    expect(enabled.map((e) => e.id)).toEqual(['brave', 'google', 'duckduckgo', 'baidu']);
  });
});

describe('preferSearchEngine', () => {
  const engines = ['bing', 'brave', 'google'].map((id) => engine(id, `https://${id}.test/?q={query}`));

  it('不点名 → 原顺序原引用', () => {
    expect(preferSearchEngine(engines)).toBe(engines);
  });

  it('点名的引擎提到最前，其余相对顺序不变', () => {
    expect(preferSearchEngine(engines, 'google').map((e) => e.id)).toEqual(['google', 'bing', 'brave']);
  });

  it('点名未知 id → 抛错并列出可用 id', () => {
    expect(() => preferSearchEngine(engines, 'kagi')).toThrow('Unknown search engine "kagi". Enabled engines: bing, brave, google');
  });
});

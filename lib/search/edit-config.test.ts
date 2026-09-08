import { describe, it, expect, vi } from 'vitest';
import {
  deleteCustomSearchEngine,
  moveSearchEngine,
  newSearchEngineDraft,
  resetBuiltinSearchEngine,
  resetBuiltinSearchEngineDraft,
  saveSearchEngineDraft,
  setSearchEngineEnabled,
} from '@/lib/search/edit-config';
import { getBuiltinSearchEngine } from '@/lib/search/defaults';
import { EXTRACT_SCRIPT_TEMPLATE } from '@/lib/search/extract';
import type { CustomSearchEngine, SearchEngineDraft, SearchEnginesConfig } from '@/lib/search/types';

vi.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
}));

const BING = getBuiltinSearchEngine('bing')!;

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

function draft(over: Partial<SearchEngineDraft> = {}): SearchEngineDraft {
  return {
    id: 'custom-aaaaaaaaaaaa',
    kind: 'custom',
    name: 'Kagi',
    urlTemplate: 'https://kagi.com/search?q={query}',
    extract: 'function extract() { return { status: "ok", results: [] }; }',
    when: '',
    ...over,
  };
}

function bingDraft(over: Partial<SearchEngineDraft> = {}): SearchEngineDraft {
  return {
    id: 'bing',
    kind: 'builtin',
    name: BING.getName(),
    urlTemplate: BING.urlTemplate,
    extract: BING.extract,
    when: '',
    ...over,
  };
}

describe('newSearchEngineDraft', () => {
  it('是自定义引擎的空白草稿，脚本预填模板，id 当场定下且互不相同', () => {
    const a = newSearchEngineDraft(config());
    const b = newSearchEngineDraft(config());
    expect(a.kind).toBe('custom');
    expect(a.name).toBe('');
    expect(a.extract).toBe(EXTRACT_SCRIPT_TEMPLATE);
    expect(a.id).toMatch(/^custom-[a-f0-9]{12}$/);
    expect(a.id).not.toBe(b.id);
  });
});

describe('saveSearchEngineDraft — 自定义引擎', () => {
  it('新草稿追加到 custom 末尾，名称去首尾空白，空的适用场景不落库', () => {
    const next = saveSearchEngineDraft(config(), draft({ name: '  Kagi ', when: '  ' }));
    expect(next.custom).toEqual([
      {
        id: 'custom-aaaaaaaaaaaa',
        name: 'Kagi',
        urlTemplate: 'https://kagi.com/search?q={query}',
        extract: 'function extract() { return { status: "ok", results: [] }; }',
      },
    ]);
  });

  it('已存在的 id 就地替换、保留列表上的停用状态，不追加', () => {
    const before = config({ custom: [customEngine({ name: 'Old', enabled: false })] });
    const next = saveSearchEngineDraft(before, draft({ name: 'New', when: 'privacy' }));
    expect(next.custom).toHaveLength(1);
    expect(next.custom[0]).toMatchObject({ name: 'New', when: 'privacy', enabled: false });
    expect(before.custom[0].name).toBe('Old');
  });

  it('脚本只去掉尾部空白，保留内部格式', () => {
    const next = saveSearchEngineDraft(config(), draft({ extract: 'function extract() {\n  return 1;\n}\n\n' }));
    expect(next.custom[0].extract).toBe('function extract() {\n  return 1;\n}');
  });
});

describe('saveSearchEngineDraft — 内置引擎', () => {
  it('与默认值完全相同 → 不写 overlay', () => {
    const next = saveSearchEngineDraft(config(), bingDraft());
    expect(next.builtin.bing).toBeUndefined();
    expect(next.custom).toEqual([]);
  });

  it('只保存与默认不同的字段', () => {
    const next = saveSearchEngineDraft(config(), bingDraft({ urlTemplate: 'https://cn.bing.com/search?q={query}' }));
    expect(next.builtin.bing).toEqual({ urlTemplate: 'https://cn.bing.com/search?q={query}' });
  });

  it('改回默认值 → overlay 整条删掉；被停用的引擎只留 enabled: false', () => {
    const modified = config({ builtin: { bing: { extract: 'x', enabled: false } } });
    const next = saveSearchEngineDraft(modified, bingDraft());
    expect(next.builtin.bing).toEqual({ enabled: false });
    const enabledNext = saveSearchEngineDraft(config({ builtin: { bing: { extract: 'x' } } }), bingDraft());
    expect(enabledNext.builtin.bing).toBeUndefined();
  });

  it('清空有默认值的适用场景（百度）→ 存空串，表示用户显式去掉了提示', () => {
    const next = saveSearchEngineDraft(
      config(),
      { id: 'baidu', kind: 'builtin', name: 'x', urlTemplate: getBuiltinSearchEngine('baidu')!.urlTemplate, extract: getBuiltinSearchEngine('baidu')!.extract, when: '' },
    );
    expect(next.builtin.baidu).toEqual({ when: '' });
  });

  it('resetBuiltinSearchEngineDraft 把草稿恢复为默认；自定义草稿原样返回', () => {
    const changed = bingDraft({ urlTemplate: 'https://x.test/{query}', extract: 'nope', when: 'w' });
    expect(resetBuiltinSearchEngineDraft(changed)).toEqual(bingDraft());
    const custom = draft();
    expect(resetBuiltinSearchEngineDraft(custom)).toBe(custom);
  });
});

describe('setSearchEngineEnabled', () => {
  it('内置：停用写 enabled: false，重新启用删掉字段（overlay 变空则整条删）', () => {
    const off = setSearchEngineEnabled(config(), 'bing', false);
    expect(off.builtin.bing).toEqual({ enabled: false });
    expect(setSearchEngineEnabled(off, 'bing', true).builtin.bing).toBeUndefined();
    const offModified = setSearchEngineEnabled(config({ builtin: { bing: { extract: 'x' } } }), 'bing', false);
    expect(setSearchEngineEnabled(offModified, 'bing', true).builtin.bing).toEqual({ extract: 'x' });
  });

  it('自定义：同样只落 false', () => {
    const off = setSearchEngineEnabled(config({ custom: [customEngine()] }), 'custom-aaaaaaaaaaaa', false);
    expect(off.custom[0].enabled).toBe(false);
    expect(setSearchEngineEnabled(off, 'custom-aaaaaaaaaaaa', true).custom[0]).not.toHaveProperty('enabled');
  });
});

describe('resetBuiltinSearchEngine', () => {
  it('丢掉地址 / 脚本 / 适用场景的修改，保留停用状态；自定义 id 原样返回', () => {
    const cfg = config({ builtin: { bing: { extract: 'x', enabled: false }, google: { when: 'w' } } });
    const next = resetBuiltinSearchEngine(cfg, 'bing');
    expect(next.builtin.bing).toEqual({ enabled: false });
    expect(resetBuiltinSearchEngine(next, 'google').builtin.google).toBeUndefined();
    expect(resetBuiltinSearchEngine(cfg, 'custom-aaaaaaaaaaaa')).toBe(cfg);
  });
});

describe('deleteCustomSearchEngine', () => {
  it('删掉自定义引擎并清理 order 里的残留；内置 id 原样返回', () => {
    const cfg = config({ custom: [customEngine()], order: ['custom-aaaaaaaaaaaa', 'bing'] });
    const next = deleteCustomSearchEngine(cfg, 'custom-aaaaaaaaaaaa');
    expect(next.custom).toEqual([]);
    expect(next.order).toEqual(['bing']);
    expect(deleteCustomSearchEngine(cfg, 'bing')).toBe(cfg);
  });
});

describe('moveSearchEngine', () => {
  it('落库的是完整顺序：上移 google 后 order 含全部 id', () => {
    const next = moveSearchEngine(config({ custom: [customEngine()] }), 'google', -1);
    expect(next.order).toEqual(['bing', 'google', 'brave', 'duckduckgo', 'baidu', 'custom-aaaaaaaaaaaa']);
  });

  it('已在两端或未知 id → 原样返回', () => {
    const cfg = config();
    expect(moveSearchEngine(cfg, 'bing', -1)).toBe(cfg);
    expect(moveSearchEngine(cfg, 'baidu', 1)).toBe(cfg);
    expect(moveSearchEngine(cfg, 'ghost', 1)).toBe(cfg);
  });
});

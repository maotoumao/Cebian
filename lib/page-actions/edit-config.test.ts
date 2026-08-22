import { describe, it, expect, vi } from 'vitest';
import {
  deleteCustomAction,
  moveAction,
  newActionDraft,
  resetBuiltinActionDraft,
  saveActionDraft,
  setActionEnabled,
} from '@/lib/page-actions/edit-config';
import type { CustomPageAction, PageActionDraft, PageActionsConfig } from '@/lib/page-actions/types';

vi.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
}));

function config(over: Partial<PageActionsConfig> = {}): PageActionsConfig {
  return { builtin: {}, custom: [], ...over };
}

function customAction(over: Partial<CustomPageAction> = {}): CustomPageAction {
  return { id: 'custom-aaaaaaaaaaaa', label: 'Extract', systemPrompt: 'do it', ...over };
}

function draft(over: Partial<PageActionDraft> = {}): PageActionDraft {
  return {
    id: 'custom-aaaaaaaaaaaa',
    kind: 'custom',
    label: 'Extract',
    systemPrompt: 'do it',
    pages: { include: [], exclude: [] },
    transform: '',
    ...over,
  };
}

describe('newActionDraft', () => {
  it('是自定义动作的空白草稿，id 当场定下且互不相同', () => {
    const a = newActionDraft(config());
    const b = newActionDraft(config());
    expect(a.kind).toBe('custom');
    expect(a.label).toBe('');
    expect(a.id).toMatch(/^custom-[a-f0-9]{12}$/);
    expect(a.id).not.toBe(b.id);
  });
});

describe('saveActionDraft — 自定义动作', () => {
  it('新草稿追加到 custom 末尾', () => {
    const next = saveActionDraft(config(), draft());
    expect(next.custom).toHaveLength(1);
    expect(next.custom[0]).toEqual({
      id: 'custom-aaaaaaaaaaaa',
      label: 'Extract',
      systemPrompt: 'do it',
    });
  });

  it('已存在的 id 就地替换，不追加', () => {
    const before = config({ custom: [customAction({ label: 'Old' })] });
    const next = saveActionDraft(before, draft({ label: 'New' }));
    expect(next.custom).toHaveLength(1);
    expect(next.custom[0].label).toBe('New');
  });

  it('保留列表上维护的 enabled，不被编辑页重置', () => {
    const before = config({ custom: [customAction({ enabled: false })] });
    expect(saveActionDraft(before, draft()).custom[0].enabled).toBe(false);
  });

  it('空 pages / 空 transform 不落库；label 去空白', () => {
    const next = saveActionDraft(config(), draft({ label: '  Extract  ', transform: '   ' }));
    expect(next.custom[0].label).toBe('Extract');
    expect(next.custom[0]).not.toHaveProperty('pages');
    expect(next.custom[0]).not.toHaveProperty('transform');
  });

  it('pages / transform 有内容则写入，且范围是复制的', () => {
    const pages = { include: ['https://a.com/*'], exclude: [] };
    const next = saveActionDraft(config(), draft({ pages, transform: 'return text' }));
    expect(next.custom[0].pages).toEqual(pages);
    expect(next.custom[0].pages).not.toBe(pages);
    expect(next.custom[0].transform).toBe('return text');
  });

  it('只配了 exclude 也算有限制，照样落库', () => {
    const next = saveActionDraft(
      config(),
      draft({ pages: { include: [], exclude: ['https://a.com/*'] } }),
    );
    expect(next.custom[0].pages).toEqual({ include: [], exclude: ['https://a.com/*'] });
  });

  it('两个列表都空 = 没做限制 → 不落库', () => {
    const next = saveActionDraft(config(), draft({ pages: { include: [], exclude: [] } }));
    expect(next.custom[0]).not.toHaveProperty('pages');
  });

  it('不改入参', () => {
    const before = config();
    saveActionDraft(before, draft());
    expect(before.custom).toHaveLength(0);
  });
});

describe('saveActionDraft — 内置动作', () => {
  it('写成 overlay，不进 custom 数组', () => {
    const next = saveActionDraft(
      config(),
      draft({
        id: 'explain',
        kind: 'builtin',
        label: '讲讲',
        systemPrompt: 'pageActions.prompts.explain',
        transform: 'return text',
      }),
    );
    expect(next.custom).toHaveLength(0);
    expect(next.builtin.explain).toEqual({ transform: 'return text' });
  });

  it('全部字段清空 → 整条 overlay 删除（回到默认）', () => {
    const before = config({
      builtin: { explain: { label: 'X', pages: { include: ['https://a.com/*'], exclude: [] } } },
    });
    const next = saveActionDraft(
      before,
      draft({
        id: 'explain',
        kind: 'builtin',
        label: '',
        systemPrompt: '',
        pages: { include: [], exclude: [] },
        transform: '',
      }),
    );
    expect(next.builtin.explain).toBeUndefined();
  });

  it('清空 label 但仍被关掉 → 保留 enabled，不误删 overlay', () => {
    const before = config({ builtin: { explain: { enabled: false, label: 'X' } } });
    const next = saveActionDraft(
      before,
      draft({ id: 'explain', kind: 'builtin', label: '', systemPrompt: '' }),
    );
    expect(next.builtin.explain).toEqual({ enabled: false });
  });

  it('清空 label 后只剩「启用」→ 整条 overlay 删除，不留 enabled: true 空壳', () => {
    const before = config({ builtin: { explain: { enabled: true, label: 'X' } } });
    const next = saveActionDraft(
      before,
      draft({ id: 'explain', kind: 'builtin', label: '', systemPrompt: '' }),
    );
    expect(next.builtin.explain).toBeUndefined();
  });

  it('内置动作只保存不同于 i18n 默认值的提示词', () => {
    const next = saveActionDraft(
      config(),
      draft({ id: 'explain', kind: 'builtin', label: 'X', systemPrompt: 'hijack' }),
    );
    expect(next.builtin.explain?.systemPrompt).toBe('hijack');

    const fallback = saveActionDraft(
      next,
      draft({
        id: 'explain',
        kind: 'builtin',
        label: 'X',
        systemPrompt: 'pageActions.prompts.explain',
      }),
    );
    expect(fallback.builtin.explain).toBeUndefined();

    const paddedFallback = saveActionDraft(
      next,
      draft({
        id: 'explain',
        kind: 'builtin',
        label: 'X',
        systemPrompt: '  pageActions.prompts.explain  ',
      }),
    );
    expect(paddedFallback.builtin.explain).toBeUndefined();
  });

  it('内置动作不写名称覆盖；提示词按显式覆盖状态写入并可重置', () => {
    const overridden = saveActionDraft(
      config(),
      draft({
        id: 'explain',
        kind: 'builtin',
        label: 'pageActions.toolbar.explain',
        systemPrompt: 'pageActions.prompts.explain',
        systemPromptOverridden: true,
      }),
    );
    expect(overridden.builtin.explain).toEqual({
      systemPrompt: 'pageActions.prompts.explain',
    });

    const resetDraft = resetBuiltinActionDraft(
      draft({
        id: 'explain',
        kind: 'builtin',
        label: 'Custom',
        systemPrompt: 'Custom prompt',
        systemPromptOverridden: true,
        pages: { include: ['https://example.com/*'], exclude: [] },
        transform: 'function transform(text) { return text; }',
      }),
    );
    expect(resetDraft).toMatchObject({
      label: 'pageActions.toolbar.explain',
      systemPrompt: 'pageActions.prompts.explain',
      systemPromptOverridden: false,
      pages: { include: [], exclude: [] },
      transform: '',
    });

    const reset = saveActionDraft(overridden, resetDraft);
    expect(reset.builtin.explain).toBeUndefined();
  });

  it('保存时只清理旧名称覆盖，保留其它设置与顺序', () => {
    const pages = { include: ['https://example.com/*'], exclude: [] };
    const before = config({
      builtin: {
        explain: {
          enabled: false,
          label: 'Legacy',
          systemPrompt: 'Custom prompt',
          pages,
          transform: 'function transform(text) { return text; }',
        },
      },
      order: ['translate', 'explain', 'summarize'],
    });
    const next = saveActionDraft(
      before,
      draft({
        id: 'explain',
        kind: 'builtin',
        label: 'pageActions.toolbar.explain',
        systemPrompt: 'Custom prompt',
        systemPromptOverridden: true,
        pages,
        transform: 'function transform(text) { return text; }',
      }),
    );

    expect(next.builtin.explain).toEqual({
      enabled: false,
      systemPrompt: 'Custom prompt',
      pages,
      transform: 'function transform(text) { return text; }',
    });
    expect(next.order).toEqual(['translate', 'explain', 'summarize']);
  });
});

describe('setActionEnabled', () => {
  it('关掉内置动作 → 写 overlay.enabled=false', () => {
    expect(setActionEnabled(config(), 'translate', false).builtin.translate).toEqual({
      enabled: false,
    });
  });

  it('重新开启且无其它改动 → 删掉 overlay 空壳', () => {
    const before = config({ builtin: { translate: { enabled: false } } });
    expect(setActionEnabled(before, 'translate', true).builtin.translate).toBeUndefined();
  });

  it('重新开启但有其它改动 → 保留 overlay，且不留 enabled: true 空字段', () => {
    const before = config({ builtin: { translate: { enabled: false, label: 'T' } } });
    expect(setActionEnabled(before, 'translate', true).builtin.translate).toEqual({ label: 'T' });
  });

  it('自定义动作重新开启 → 去掉 enabled 字段（省略即启用）', () => {
    const before = config({ custom: [customAction({ enabled: false })] });
    const next = setActionEnabled(before, 'custom-aaaaaaaaaaaa', true);
    expect(next.custom[0]).not.toHaveProperty('enabled');
  });

  it('自定义动作写自身字段', () => {
    const before = config({ custom: [customAction()] });
    expect(setActionEnabled(before, 'custom-aaaaaaaaaaaa', false).custom[0].enabled).toBe(false);
  });
});

describe('newActionDraft — id 冲突', () => {
  it('生成的 id 已被占用时换一个，不覆盖已有动作', () => {
    const taken = 'custom-aaaaaaaaaaaa';
    const uuids = ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'];
    const spy = vi.spyOn(crypto, 'randomUUID').mockImplementation(
      () => uuids.shift() as ReturnType<typeof crypto.randomUUID>,
    );
    try {
      const next = newActionDraft(config({ custom: [customAction({ id: taken })] }));
      expect(next.id).not.toBe(taken);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('deleteCustomAction', () => {
  it('删掉自定义动作，并清掉顺序里的残留 id', () => {
    const before = config({
      custom: [customAction()],
      order: ['custom-aaaaaaaaaaaa', 'explain'],
    });
    const next = deleteCustomAction(before, 'custom-aaaaaaaaaaaa');
    expect(next.custom).toHaveLength(0);
    expect(next.order).toEqual(['explain']);
  });

  it('内置动作删不掉（只能关）', () => {
    const before = config();
    expect(deleteCustomAction(before, 'explain')).toBe(before);
  });
});

describe('moveAction', () => {
  it('上移一格，落库的是完整顺序', () => {
    const next = moveAction(config(), 'translate', -1);
    expect(next.order).toEqual(['translate', 'explain', 'summarize']);
  });

  it('下移一格', () => {
    const next = moveAction(config(), 'explain', 1);
    expect(next.order).toEqual(['translate', 'explain', 'summarize']);
  });

  it('已在两端 → 原样返回（不写库）', () => {
    const before = config();
    expect(moveAction(before, 'explain', -1)).toBe(before);
    expect(moveAction(before, 'summarize', 1)).toBe(before);
  });

  it('未知 id → 原样返回', () => {
    const before = config();
    expect(moveAction(before, 'custom-nope12345678', -1)).toBe(before);
  });

  it('自定义动作也能排到内置之前', () => {
    const before = config({ custom: [customAction()] });
    const next = moveAction(before, 'custom-aaaaaaaaaaaa', -1);
    expect(next.order).toEqual([
      'explain',
      'translate',
      'custom-aaaaaaaaaaaa',
      'summarize',
    ]);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { findPageAction, listPageActions, visibleToolbarActions } from '@/lib/page-actions/actions';
import type { CustomPageAction, PageActionsConfig } from '@/lib/page-actions/types';

// 内置动作的 label 走 `t`，而 fakeBrowser 不实现 chrome.i18n.getMessage。
// Mock 成回显 key：测的是「label 从哪来、overlay 有没有覆盖」，不耦合具体译文。
vi.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
}));

const PAGE = 'https://example.com/docs/intro';

function config(over: Partial<PageActionsConfig> = {}): PageActionsConfig {
  return { builtin: {}, custom: [], ...over };
}

function custom(over: Partial<CustomPageAction> = {}): CustomPageAction {
  return {
    id: 'custom-abcdef123456',
    label: 'Extract',
    systemPrompt: 'Extract key points from {{selected_text}}.',
    ...over,
  };
}

describe('visibleToolbarActions — 缺省配置', () => {
  it('三个内置动作全显示，顺序为解释 / 翻译 / 总结', () => {
    const ids = visibleToolbarActions(config(), PAGE).map((a) => a.id);
    expect(ids).toEqual(['explain', 'translate', 'summarize']);
  });

  it('内置动作 label 回落到界面文案，kind 标为 builtin', () => {
    const explain = visibleToolbarActions(config(), PAGE)[0];
    expect(explain.kind).toBe('builtin');
    expect(explain.label.length).toBeGreaterThan(0);
  });
});

describe('visibleToolbarActions — 内置 overlay', () => {
  it('enabled=false 的内置动作不显示', () => {
    const ids = visibleToolbarActions(
      config({ builtin: { translate: { enabled: false } } }),
      PAGE,
    ).map((a) => a.id);
    expect(ids).toEqual(['explain', 'summarize']);
  });

  it('overlay 的 label 覆盖界面文案；空白 label 视为没改', () => {
    const [renamed] = visibleToolbarActions(
      config({ builtin: { explain: { label: '讲讲' } } }),
      PAGE,
    );
    expect(renamed.label).toBe('讲讲');

    const [blank] = visibleToolbarActions(config({ builtin: { explain: { label: '  ' } } }), PAGE);
    expect(blank.label).not.toBe('  ');
    expect(blank.label.length).toBeGreaterThan(0);
  });

  it('overlay 带 pages 时只在命中页显示', () => {
    const c = config({ builtin: { translate: { pages: ['https://other.com/*'] } } });
    expect(visibleToolbarActions(c, PAGE).map((a) => a.id)).toEqual(['explain', 'summarize']);
    expect(visibleToolbarActions(c, 'https://other.com/x').map((a) => a.id)).toContain('translate');
  });

  it('overlay 改不了内置提示词，只影响外观', () => {
    const [explain] = visibleToolbarActions(config({ builtin: { explain: { label: 'X' } } }), PAGE);
    expect(explain.renderSystemPrompt({ lang: 'Chinese' })).toContain('Chinese');
  });
});

describe('visibleToolbarActions — 自定义动作', () => {
  it('追加在内置之后，label 用用户输入', () => {
    const actions = visibleToolbarActions(config({ custom: [custom()] }), PAGE);
    expect(actions.map((a) => a.id)).toEqual([
      'explain',
      'translate',
      'summarize',
      'custom-abcdef123456',
    ]);
    expect(actions[3]).toMatchObject({ kind: 'custom', label: 'Extract' });
  });

  it('enabled=false 不显示；pages 不命中不显示', () => {
    expect(visibleToolbarActions(config({ custom: [custom({ enabled: false })] }), PAGE)).toHaveLength(3);
    expect(
      visibleToolbarActions(config({ custom: [custom({ pages: ['https://nope.com/*'] })] }), PAGE),
    ).toHaveLength(3);
  });

  it('system 提示词由模板渲染，user turn 就是原文', () => {
    const [action] = visibleToolbarActions(config({ custom: [custom()] }), PAGE).slice(-1);
    expect(action.renderSystemPrompt({ selected_text: 'hello' })).toBe(
      'Extract key points from hello.',
    );
    expect(action.renderUserIntent('hello', {})).toBe('hello');
  });

  it('模板里的非字符串参数被丢掉，不会渲染成 [object Object]', () => {
    const [action] = visibleToolbarActions(
      config({ custom: [custom({ systemPrompt: '{{page_url}}|{{context}}' })] }),
      PAGE,
    ).slice(-1);
    // page_url 传了对象 → 视为没给值（内置变量缺失即空串）。
    expect(action.renderSystemPrompt({ page_url: { a: 1 }, context: 'ctx' })).toBe('|ctx');
  });
});

describe('visibleToolbarActions — 排序', () => {
  it('order 决定顺序，未列出的按缺省顺序补在后面', () => {
    const c = config({ custom: [custom()], order: ['custom-abcdef123456', 'summarize'] });
    expect(visibleToolbarActions(c, PAGE).map((a) => a.id)).toEqual([
      'custom-abcdef123456',
      'summarize',
      'explain',
      'translate',
    ]);
  });

  it('order 里已不存在的 id 忽略（删动作 / 换设备不会搞坏顺序）', () => {
    const c = config({ order: ['custom-deadbeef1234', 'translate'] });
    expect(visibleToolbarActions(c, PAGE).map((a) => a.id)).toEqual([
      'translate',
      'explain',
      'summarize',
    ]);
  });

  it('order 里重复的 id 不产生重复按钮', () => {
    const c = config({ order: ['translate', 'translate'] });
    expect(visibleToolbarActions(c, PAGE).map((a) => a.id)).toEqual([
      'translate',
      'explain',
      'summarize',
    ]);
  });
});

describe('visibleToolbarActions — 脏配置', () => {
  it('重复的 custom id 只出一个按钮（无 order 时也去重）', () => {
    const c = config({ custom: [custom({ label: 'First' }), custom({ label: 'Dup' })] });
    const actions = visibleToolbarActions(c, PAGE);
    expect(actions.filter((a) => a.id === 'custom-abcdef123456')).toHaveLength(1);
    expect(actions[3].label).toBe('First');
  });

  it('非法 id 的自定义动作整条丢弃——否则按钮点了会被 IPC 守卫拒掉、永远转圈', () => {
    const c = config({ custom: [custom({ id: 'evil id' }), custom({ id: '__proto__' })] });
    expect(visibleToolbarActions(c, PAGE).map((a) => a.id)).toEqual([
      'explain',
      'translate',
      'summarize',
    ]);
  });

  it('自定义 id 与内置重名 → 丢弃（避免「这个 id 是哪个动作」有歧义）', () => {
    const c = config({ custom: [custom({ id: 'explain', label: 'Hijack' })] });
    const actions = visibleToolbarActions(c, PAGE);
    expect(actions).toHaveLength(3);
    expect(actions.find((a) => a.id === 'explain')?.label).not.toBe('Hijack');
  });

  it('builtin 里出现非内置 key（脏数据）不产生额外按钮', () => {
    const c = config({
      builtin: { nonsense: { label: 'X' } } as unknown as PageActionsConfig['builtin'],
    });
    expect(visibleToolbarActions(c, PAGE)).toHaveLength(3);
  });
});

describe('findPageAction — background 按 id 取定义', () => {
  it('内置与自定义都取得到（不受启停 / 页面规则影响）', () => {
    const c = config({
      builtin: { explain: { enabled: false } },
      custom: [custom({ enabled: false })],
    });
    expect(findPageAction(c, 'explain')?.kind).toBe('builtin');
    expect(findPageAction(c, 'custom-abcdef123456')?.kind).toBe('custom');
  });

  it('与内置重名的脏自定义动作取不到（background 也不执行它）', () => {
    const c = config({ custom: [custom({ id: 'explain', label: 'Hijack' })] });
    expect(findPageAction(c, 'explain')?.kind).toBe('builtin');
  });

  it('未知 id 与原型键都返回 undefined', () => {
    expect(findPageAction(config(), 'custom-nonexistent1')).toBeUndefined();
    expect(findPageAction(config(), '__proto__')).toBeUndefined();
    expect(findPageAction(config(), 'constructor')).toBeUndefined();
  });

  it('取到的自定义动作带 transform（配了才有）', () => {
    const withScript = config({ custom: [custom({ transform: 'return text.trim()' })] });
    expect(findPageAction(withScript, 'custom-abcdef123456')?.transform).toBe(
      'return text.trim()',
    );
    expect(findPageAction(config({ custom: [custom()] }), 'custom-abcdef123456')?.transform).toBeUndefined();
  });
});

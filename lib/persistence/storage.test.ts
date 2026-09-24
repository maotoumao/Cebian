import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  autoTitleSettings,
  chatAppearance,
  resolveChatAppearance,
  memorySettings,
  memoryOrganizeState,
  resolveAutoTitleSettings,
  resolveOrganizeSettings,
  resolvePageInteractionSettings,
} from '@/lib/persistence/storage';

// organize 配置的回填：早期只存 { enabled }，后续加了 organize 子结构。WXT 的 fallback
// 只在 key 整体缺失时生效、不补「已存在但缺字段」的旧值，故读整理配置统一走
// resolveOrganizeSettings。运行结果态另存 memoryOrganizeState（与用户配置分离，防读改写覆盖）。
const DEFAULTS = { auto: false, intervalDays: 14, minNewMemories: 30 };

describe('resolveAutoTitleSettings', () => {
  it('缺失 / 空对象 → 默认开、跟随主模型', () => {
    expect(resolveAutoTitleSettings(undefined)).toEqual({ enabled: true, model: null });
    expect(resolveAutoTitleSettings({})).toEqual({ enabled: true, model: null });
  });

  it('部分字段 → 缺的补默认、有的保留', () => {
    expect(resolveAutoTitleSettings({ enabled: false })).toEqual({ enabled: false, model: null });
    const model = { provider: 'p', modelId: 'm' };
    expect(resolveAutoTitleSettings({ model })).toEqual({ enabled: true, model });
  });

  it('storage fallback 与默认值一致', async () => {
    fakeBrowser.reset();
    expect(await autoTitleSettings.getValue()).toEqual({ enabled: true, model: null });
  });
});

describe('resolveOrganizeSettings', () => {
  it('organize 缺失 → 全默认', () => {
    expect(resolveOrganizeSettings({ enabled: true })).toEqual(DEFAULTS);
  });

  it('organize 部分字段（仅 auto） → 缺的补默认、有的保留', () => {
    const r = resolveOrganizeSettings({ enabled: true, organize: { auto: true } as never });
    expect(r.auto).toBe(true);
    expect(r.intervalDays).toBe(14);
    expect(r.minNewMemories).toBe(30);
  });

  it('organize 含 model 配置 → 一并保留', () => {
    const model = { provider: 'p', modelId: 'm' };
    const r = resolveOrganizeSettings({
      enabled: true,
      organize: { auto: true, intervalDays: 3, minNewMemories: 20, model },
    });
    expect(r.intervalDays).toBe(3);
    expect(r.model).toEqual(model);
  });
});

describe('memorySettings 存储项', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('新装机 → fallback 含完整 organize 默认配置', async () => {
    const v = await memorySettings.getValue();
    expect(v.enabled).toBe(false);
    expect(resolveOrganizeSettings(v)).toEqual(DEFAULTS);
  });

  it('旧值 { enabled } → 读出仍能规范化出 organize 默认（不炸）', async () => {
    await fakeBrowser.storage.local.set({ memorySettings: { enabled: true } });
    const v = await memorySettings.getValue();
    expect(v.enabled).toBe(true);
    expect(resolveOrganizeSettings(v)).toEqual(DEFAULTS);
  });
});

describe('memoryOrganizeState 存储项', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('新装机 → 空对象（无上次整理记录）', async () => {
    expect(await memoryOrganizeState.getValue()).toEqual({});
  });
});

describe('resolvePageInteractionSettings — 页面生效范围', () => {
  it('缺省补成两个空范围（= 所有页面生效）', () => {
    const s = resolvePageInteractionSettings(undefined);
    expect(s.ballPages).toEqual({ include: [], exclude: [] });
    expect(s.toolbarPages).toEqual({ include: [], exclude: [] });
  });

  it('未发布旧形状的「隐藏页面」按 exclude 读进来（开发期配过的规则不静默失效）', () => {
    const s = resolvePageInteractionSettings({
      ballHiddenPages: ['https://a.com/*'],
      toolbarHiddenPages: ['https://b.com/*'],
    } as never);
    expect(s.ballPages).toEqual({ include: [], exclude: ['https://a.com/*'] });
    expect(s.toolbarPages).toEqual({ include: [], exclude: ['https://b.com/*'] });
  });

  it('新字段一旦存在就以它为准——哪怕是空范围，旧规则不会复活', () => {
    // 关键回归：用户在新 UI 里清空了规则。若按「空就回读旧列表」处理，旧规则会被一次次
    // 兜回来、永远删不掉。
    const s = resolvePageInteractionSettings({
      toolbarPages: { include: [], exclude: [] },
      toolbarHiddenPages: ['https://old.com/*'],
    } as never);
    expect(s.toolbarPages).toEqual({ include: [], exclude: [] });
  });

  it('返回值不带旧字段（主面板整体写回时不会把它再存一遍）', () => {
    const s = resolvePageInteractionSettings({
      toolbarHiddenPages: ['https://old.com/*'],
    } as never);
    expect(Object.hasOwn(s, 'toolbarHiddenPages')).toBe(false);
    expect(s.toolbarPages).toEqual({ include: [], exclude: ['https://old.com/*'] });
  });

  it('已用新 UI 配过范围时以新配置为准，不再拿旧字段兜', () => {
    const s = resolvePageInteractionSettings({
      toolbarPages: { include: ['https://new.com/*'], exclude: [] },
      toolbarHiddenPages: ['https://old.com/*'],
    } as never);
    expect(s.toolbarPages).toEqual({ include: ['https://new.com/*'], exclude: [] });
  });

  it('范围是复制的，改动结果不污染入参', () => {
    const stored = { toolbarPages: { include: ['https://a.com/*'], exclude: [] } };
    const s = resolvePageInteractionSettings(stored);
    s.toolbarPages.include.push('https://b.com/*');
    expect(stored.toolbarPages.include).toEqual(['https://a.com/*']);
  });
});

describe('resolveChatAppearance', () => {
  const DEFAULT = { fontScalePercent: 100, fontPreset: 'default', customFontName: '' };

  it('缺失 / 空对象 → 默认值（100%、默认字体）', () => {
    expect(resolveChatAppearance(undefined)).toEqual(DEFAULT);
    expect(resolveChatAppearance(null)).toEqual(DEFAULT);
    expect(resolveChatAppearance({})).toEqual(DEFAULT);
  });

  it('合法值原样保留', () => {
    const v = { fontScalePercent: 120, fontPreset: 'custom' as const, customFontName: 'LXGW WenKai' };
    expect(resolveChatAppearance(v)).toEqual(v);
  });

  it('字号夹到 80–150 并吸附到 5 的倍数', () => {
    expect(resolveChatAppearance({ fontScalePercent: 10 }).fontScalePercent).toBe(80);
    expect(resolveChatAppearance({ fontScalePercent: 999 }).fontScalePercent).toBe(150);
    expect(resolveChatAppearance({ fontScalePercent: 112 }).fontScalePercent).toBe(110);
    expect(resolveChatAppearance({ fontScalePercent: 113 }).fontScalePercent).toBe(115);
  });

  it('非有限数字的字号退回默认，而不是被夹成最小值', () => {
    for (const bad of [null, '', '120', Number.NaN, Number.POSITIVE_INFINITY, [], {}]) {
      expect(resolveChatAppearance({ fontScalePercent: bad as never }).fontScalePercent).toBe(100);
    }
  });

  it('未知字体预设退回默认', () => {
    expect(resolveChatAppearance({ fontPreset: 'comic' as never }).fontPreset).toBe('default');
    expect(resolveChatAppearance({ fontPreset: 42 as never }).fontPreset).toBe('default');
  });

  it('自定义字体名去首尾空白、截断到 64 字符，非字符串退回空串', () => {
    expect(resolveChatAppearance({ customFontName: '  Inter  ' }).customFontName).toBe('Inter');
    expect(resolveChatAppearance({ customFontName: 'x'.repeat(100) }).customFontName).toHaveLength(64);
    expect(resolveChatAppearance({ customFontName: 7 as never }).customFontName).toBe('');
    // 截断点落在空格上时不留尾部空白（否则加引号后匹配不到字体）
    expect(resolveChatAppearance({ customFontName: 'a'.repeat(63) + ' b' }).customFontName).toBe('a'.repeat(63));
  });

  it('storage fallback 与默认值一致', async () => {
    fakeBrowser.reset();
    expect(await chatAppearance.getValue()).toEqual(DEFAULT);
    // 读 fallback 不落盘：原始 key 仍缺失，备份 merge 才能把整个对象补进来
    expect(await fakeBrowser.storage.local.get('chatAppearance')).toEqual({});
  });
});

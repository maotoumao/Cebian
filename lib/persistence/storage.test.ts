import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  memorySettings,
  memoryOrganizeState,
  resolveOrganizeSettings,
  resolvePageInteractionSettings,
} from '@/lib/persistence/storage';

// organize 配置的回填：早期只存 { enabled }，后续加了 organize 子结构。WXT 的 fallback
// 只在 key 整体缺失时生效、不补「已存在但缺字段」的旧值，故读整理配置统一走
// resolveOrganizeSettings。运行结果态另存 memoryOrganizeState（与用户配置分离，防读改写覆盖）。
const DEFAULTS = { auto: false, intervalDays: 14, minNewMemories: 30 };

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

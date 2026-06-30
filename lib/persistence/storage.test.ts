import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  memorySettings,
  memoryOrganizeState,
  resolveOrganizeSettings,
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

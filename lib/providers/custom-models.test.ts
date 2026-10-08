import { describe, it, expect } from 'vitest';
import { applyFetchedSelection, supportsToolCalling, toModel } from '@/lib/providers/custom-models';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import type { CustomModelDef, CustomProviderConfig } from '@/lib/persistence/storage';

const configured: CustomModelDef = {
  modelId: 'gpt-x',
  name: 'gpt-x',
  reasoning: true,
  image: true,
  contextWindow: 200000,
  maxTokens: 4096,
};

describe('applyFetchedSelection', () => {
  const fresh = (modelId: string): CustomModelDef => ({ modelId, name: modelId, reasoning: false, image: false });
  const manual: CustomModelDef = { modelId: 'manual-only', name: 'manual-only', reasoning: true, image: false };

  it('首次获取（列表为空）：只加入勾选的，以默认值补入，顺序跟随远端', () => {
    expect(applyFetchedSelection([], ['a', 'b', 'c'], new Set(['c', 'a']))).toEqual([fresh('a'), fresh('c')]);
  });

  it('首次获取一个都没勾 → 仍为空', () => {
    expect(applyFetchedSelection([], ['a', 'b'], new Set())).toEqual([]);
  });

  it('勾选的既有模型保留原配置（含「不支持工具调用」）', () => {
    const chatOnly: CustomModelDef = { ...configured, toolCalling: false };
    expect(applyFetchedSelection([chatOnly], ['gpt-x'], new Set(['gpt-x']))).toEqual([chatOnly]);
  });

  it('远端有但没勾的既有模型被移除', () => {
    expect(applyFetchedSelection([configured, fresh('b')], ['gpt-x', 'b'], new Set(['b']))).toEqual([fresh('b')]);
  });

  it('不在远端列表里的手动模型原样保留，哪怕什么都没勾', () => {
    expect(applyFetchedSelection([manual, configured], ['gpt-x'], new Set())).toEqual([manual]);
  });

  it('既有模型保持原顺序，新模型按远端顺序追加在后', () => {
    expect(
      applyFetchedSelection([fresh('z'), manual, configured], ['new2', 'gpt-x', 'z', 'new1'], new Set(['gpt-x', 'z', 'new1', 'new2'])),
    ).toEqual([fresh('z'), manual, configured, fresh('new2'), fresh('new1')]);
  });

  it('远端重复 id 只补入一次', () => {
    expect(applyFetchedSelection([], ['a', 'a'], new Set(['a']))).toEqual([fresh('a')]);
  });

  it('勾选集里不在远端列表的 id 被忽略', () => {
    expect(applyFetchedSelection([], ['a'], new Set(['a', 'ghost']))).toEqual([fresh('a')]);
  });
});

describe('toModel', () => {
  const cfg: CustomProviderConfig = { id: 'p', name: 'P', baseUrl: 'https://x/v1', models: [] };
  const m: CustomModelDef = { modelId: 'm', name: 'm', reasoning: false };

  it('默认禁用 developer 角色并用 max_tokens 字段，避免第三方端点不兼容 (#46 #57 #54)', () => {
    const expected = { supportsDeveloperRole: false, maxTokensField: 'max_tokens' };
    expect(toModel(cfg, m).compat).toEqual(expected);
    expect(toModel(cfg, { ...m, reasoning: true }).compat).toEqual(expected);
  });

  it('provider 有 headers → 并入 model.headers', () => {
    expect(toModel({ ...cfg, headers: { 'X-A': '1' } }, m).headers).toEqual({ 'X-A': '1' });
  });

  it('无 headers / 空 headers → model 不带 headers', () => {
    expect(toModel(cfg, m).headers).toBeUndefined();
    expect(toModel({ ...cfg, headers: {} }, m).headers).toBeUndefined();
  });
});

describe('supportsToolCalling', () => {
  const cfg: CustomProviderConfig = { id: 'p', name: 'P', baseUrl: 'https://x/v1', models: [] };
  const m: CustomModelDef = { modelId: 'm', name: 'm', reasoning: false };

  it('自定义模型缺省 / 显式开启都支持工具调用', () => {
    expect(supportsToolCalling(toModel(cfg, m))).toBe(true);
    expect(supportsToolCalling(toModel(cfg, { ...m, toolCalling: true }))).toBe(true);
  });

  it('关闭后不支持，且标记在展开复制后仍保留', () => {
    const model = toModel(cfg, { ...m, toolCalling: false });
    expect(supportsToolCalling(model)).toBe(false);
    expect(supportsToolCalling({ ...model })).toBe(false);
  });

  it('内置模型一律支持', () => {
    const builtin = getBuiltinModels('anthropic');
    expect(builtin.length).toBeGreaterThan(0);
    expect(builtin.every(supportsToolCalling)).toBe(true);
  });
});

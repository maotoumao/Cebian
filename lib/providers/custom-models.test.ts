import { describe, it, expect } from 'vitest';
import { mergeFetchedModels, toModel } from '@/lib/providers/custom-models';
import type { CustomModelDef, CustomProviderConfig } from '@/lib/persistence/storage';

const configured: CustomModelDef = {
  modelId: 'gpt-x',
  name: 'gpt-x',
  reasoning: true,
  image: true,
  contextWindow: 200000,
  maxTokens: 4096,
};

describe('mergeFetchedModels', () => {
  it('仍存在的模型保留既有配置', () => {
    expect(mergeFetchedModels([configured], ['gpt-x'])).toEqual([configured]);
  });

  it('新模型以默认值补入', () => {
    expect(mergeFetchedModels([], ['new'])).toEqual([
      { modelId: 'new', name: 'new', reasoning: false, image: false },
    ]);
  });

  it('混合：保留旧的、补入新的、丢弃远端已消失的，顺序跟随远端', () => {
    const other: CustomModelDef = { modelId: 'keep', name: 'keep', reasoning: false, image: false };
    expect(mergeFetchedModels([configured, other], ['new', 'gpt-x'])).toEqual([
      { modelId: 'new', name: 'new', reasoning: false, image: false },
      configured,
    ]);
  });

  it('远端重复 id 只取首个', () => {
    expect(mergeFetchedModels([configured], ['gpt-x', 'gpt-x'])).toEqual([configured]);
  });

  it('空远端 → 清空', () => {
    expect(mergeFetchedModels([configured], [])).toEqual([]);
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

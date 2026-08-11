import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { customProviderKey } from '@/lib/providers/custom-models';
import {
  memorySettings,
  lastSelectedModel,
  customProviders,
  type CustomProviderConfig,
  type ModelIdentity,
} from '@/lib/persistence/storage';
import { resolveOrganizeModel } from './organize-manager';

// 用自定义 provider 构造可解析的模型身份：不依赖 pi-ai 内置目录，随其版本演进不会脆断。
const ORGANIZE_PROVIDER = customProviderKey('organize-provider');
const GLOBAL_PROVIDER = customProviderKey('global-provider');

const PROVIDERS: CustomProviderConfig[] = [
  {
    id: 'organize-provider',
    name: 'Organize Provider',
    baseUrl: 'https://organize.example/v1',
    models: [{ modelId: 'organize-model', name: 'Organize Model', reasoning: false }],
  },
  {
    id: 'global-provider',
    name: 'Global Provider',
    baseUrl: 'https://global.example/v1',
    models: [{ modelId: 'global-model', name: 'Global Model', reasoning: false }],
  },
];

/** 指向一个已被删除的 provider —— 模拟「配过整理专用模型，后来把它删了」。 */
const DELETED: ModelIdentity = { provider: customProviderKey('gone-provider'), modelId: 'gone-model' };

async function setOrganizeModel(model?: ModelIdentity): Promise<void> {
  await memorySettings.setValue({
    enabled: true,
    organize: { model, auto: false, intervalDays: 14, minNewMemories: 30 },
  });
}

describe('resolveOrganizeModel', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    fakeBrowser.reset();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await customProviders.setValue(PROVIDERS);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('未配整理专用模型 → 用全局模型', async () => {
    await setOrganizeModel(undefined);
    await lastSelectedModel.setValue({ provider: GLOBAL_PROVIDER, modelId: 'global-model' });

    const model = await resolveOrganizeModel();
    expect(model?.id).toBe('global-model');
    expect(warn).not.toHaveBeenCalled();
  });

  it('配了整理专用模型且可解析 → 用专用模型', async () => {
    await setOrganizeModel({ provider: ORGANIZE_PROVIDER, modelId: 'organize-model' });
    await lastSelectedModel.setValue({ provider: GLOBAL_PROVIDER, modelId: 'global-model' });

    const model = await resolveOrganizeModel();
    expect(model?.id).toBe('organize-model');
    expect(warn).not.toHaveBeenCalled();
  });

  // 回归守卫：专用模型被删后曾直接返回 null，导致自动整理永久 `skipped: no-model`，
  // 而它是 alarm 静默任务，用户收不到任何提示。
  it('配了整理专用模型但解析不出（模型/provider 已删）→ warn 后回退全局模型', async () => {
    await setOrganizeModel(DELETED);
    await lastSelectedModel.setValue({ provider: GLOBAL_PROVIDER, modelId: 'global-model' });

    const model = await resolveOrganizeModel();
    expect(model?.id).toBe('global-model');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual(DELETED);
  });

  it('专用模型解析不出、全局也解析不出 → null', async () => {
    await setOrganizeModel(DELETED);
    await lastSelectedModel.setValue({ provider: GLOBAL_PROVIDER, modelId: 'also-gone' });

    expect(await resolveOrganizeModel()).toBeNull();
  });

  it('两者都没配 → null', async () => {
    await setOrganizeModel(undefined);
    await lastSelectedModel.setValue(null);

    expect(await resolveOrganizeModel()).toBeNull();
  });
});

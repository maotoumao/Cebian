import { describe, it, expect } from 'vitest';
import { getBuiltinModels, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all';
import type { Api, Model } from '@earendil-works/pi-ai';
import { listUsableModelGroups, hasUsableModel, isUsableModel } from '@/lib/providers/usable-models';
import { customProviderKey } from '@/lib/providers/custom-models';
import { resolveModel } from '@/lib/providers/resolve-model';
import type {
  ProviderCredentials,
  CustomProviderConfig,
} from '@/lib/persistence/storage';

const NO_CREDS: ProviderCredentials = {};
const NO_CUSTOM: CustomProviderConfig[] = [];

/** pi-ai 目录里有模型的内置 provider；目录为空则返回 undefined，让相关用例跳过断言。 */
function builtinWithModels(provider: BuiltinProvider): boolean {
  try {
    return (getBuiltinModels(provider) as Model<Api>[]).length > 0;
  } catch {
    return false;
  }
}

const customConfig: CustomProviderConfig = {
  id: 'acme',
  name: 'Acme',
  baseUrl: 'https://acme.example/v1',
  models: [{ modelId: 'acme-fast', name: 'Acme Fast', reasoning: false }],
};

describe('listUsableModelGroups / hasUsableModel', () => {
  it('无凭据无自定义 → 空 / false', () => {
    expect(listUsableModelGroups(NO_CREDS, NO_CUSTOM)).toEqual([]);
    expect(hasUsableModel(NO_CREDS, NO_CUSTOM)).toBe(false);
  });

  it('自定义 provider 恒可见（即便没 API key 凭据）', () => {
    const groups = listUsableModelGroups(NO_CREDS, [customConfig]);
    expect(groups).toHaveLength(1);
    expect(groups[0].provider).toBe(customProviderKey('acme'));
    expect(groups[0].models.map((m) => m.id)).toContain('acme-fast');
    expect(hasUsableModel(NO_CREDS, [customConfig])).toBe(true);
  });

  it('内置 apiKey provider：填了 key 就可选，无视 verified', () => {
    if (!builtinWithModels('openai')) return;
    const creds: ProviderCredentials = {
      openai: { authType: 'apiKey', apiKey: 'sk-x', verified: false },
    };
    expect(hasUsableModel(creds, NO_CUSTOM)).toBe(true);
  });

  it('内置 apiKey provider：空 key → 不可选', () => {
    const creds: ProviderCredentials = {
      openai: { authType: 'apiKey', apiKey: '', verified: true },
    };
    expect(hasUsableModel(creds, NO_CUSTOM)).toBe(false);
  });

  it('内置 oauth provider：未 verified → 不可选；verified → 可选', () => {
    if (!builtinWithModels('github-copilot')) return;
    const unverified: ProviderCredentials = {
      'github-copilot': { authType: 'oauth', accessToken: 't', verified: false },
    };
    expect(hasUsableModel(unverified, NO_CUSTOM)).toBe(false);

    const verified: ProviderCredentials = {
      'github-copilot': { authType: 'oauth', accessToken: 't', verified: true },
    };
    expect(hasUsableModel(verified, NO_CUSTOM)).toBe(true);
  });
});

describe('isUsableModel', () => {
  const customKey = customProviderKey('acme');

  it('自定义 provider 里存在的模型 → true；不在列表里的 modelId → false', () => {
    expect(isUsableModel({ provider: customKey, modelId: 'acme-fast' }, NO_CREDS, [customConfig])).toBe(true);
    expect(isUsableModel({ provider: customKey, modelId: 'acme-gone' }, NO_CREDS, [customConfig])).toBe(false);
  });

  it('自定义 provider 整个被删 → false', () => {
    expect(isUsableModel({ provider: customKey, modelId: 'acme-fast' }, NO_CREDS, NO_CUSTOM)).toBe(false);
  });

  it('内置 provider：模型仍在目录里且有凭据 → true；modelId 已下架 → false', () => {
    if (!builtinWithModels('openai')) return;
    const creds: ProviderCredentials = {
      openai: { authType: 'apiKey', apiKey: 'sk-x', verified: true },
    };
    const existing = (getBuiltinModels('openai') as Model<Api>[])[0].id;
    expect(isUsableModel({ provider: 'openai', modelId: existing }, creds, NO_CUSTOM)).toBe(true);
    expect(isUsableModel({ provider: 'openai', modelId: 'gpt-does-not-exist' }, creds, NO_CUSTOM)).toBe(false);
  });

  // 这条是本判据存在的理由：凭据被删后 resolveModel 依然解析得出，若拿它当门禁就会
  // 放行一个必然失败的请求（issue #62）。
  it('凭据被移除后：resolveModel 仍解析得出，isUsableModel 判 false', () => {
    if (!builtinWithModels('openai')) return;
    const existing = (getBuiltinModels('openai') as Model<Api>[])[0].id;
    const identity = { provider: 'openai', modelId: existing };
    expect(resolveModel(identity, NO_CREDS, NO_CUSTOM)).not.toBeNull();
    expect(isUsableModel(identity, NO_CREDS, NO_CUSTOM)).toBe(false);
  });

  it('未知 provider → false', () => {
    expect(isUsableModel({ provider: 'nope', modelId: 'x' }, NO_CREDS, NO_CUSTOM)).toBe(false);
  });
});

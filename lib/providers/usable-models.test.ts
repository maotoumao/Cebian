import { describe, it, expect } from 'vitest';
import { getModels } from '@earendil-works/pi-ai/compat';
import type { KnownProvider, Api, Model } from '@earendil-works/pi-ai';
import { listUsableModelGroups, hasUsableModel } from '@/lib/providers/usable-models';
import { customProviderKey } from '@/lib/providers/custom-models';
import type {
  ProviderCredentials,
  CustomProviderConfig,
} from '@/lib/persistence/storage';

const NO_CREDS: ProviderCredentials = {};
const NO_CUSTOM: CustomProviderConfig[] = [];

/** pi-ai 目录里有模型的内置 provider；目录为空则返回 undefined，让相关用例跳过断言。 */
function builtinWithModels(provider: string): boolean {
  try {
    return (getModels(provider as KnownProvider) as Model<Api>[]).length > 0;
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

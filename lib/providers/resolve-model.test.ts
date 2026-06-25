import { describe, it, expect } from 'vitest';
import { getModels } from '@earendil-works/pi-ai/compat';
import type { KnownProvider, Api, Model } from '@earendil-works/pi-ai';
import { resolveModel } from '@/lib/providers/resolve-model';
import { customProviderKey } from '@/lib/providers/custom-models';
import type {
  ProviderCredentials,
  CustomProviderConfig,
  OAuthCredential,
} from '@/lib/persistence/storage';

const NO_CREDS: ProviderCredentials = {};
const NO_CUSTOM: CustomProviderConfig[] = [];

/** 从 pi-ai 真实目录里取某 provider 的第一个 modelId；目录为空则返回 undefined，
 *  让对应用例跳过断言（避免随 pi-ai 版本演进而脆断）。 */
function firstModelId(provider: string): string | undefined {
  try {
    const models = getModels(provider as KnownProvider) as Model<Api>[];
    return models[0]?.id;
  } catch {
    return undefined;
  }
}

const customConfig: CustomProviderConfig = {
  id: 'acme',
  name: 'Acme',
  baseUrl: 'https://acme.example/v1',
  models: [
    { modelId: 'acme-fast', name: 'Acme Fast', reasoning: false },
    { modelId: 'acme-think', name: 'Acme Think', reasoning: true },
  ],
};

describe('resolveModel — custom provider', () => {
  it('解析自定义模型并保留其 id / reasoning', () => {
    const key = customProviderKey('acme');
    const model = resolveModel({ provider: key, modelId: 'acme-think' }, NO_CREDS, [customConfig]);
    expect(model).not.toBeNull();
    expect(model!.id).toBe('acme-think');
    expect(model!.reasoning).toBe(true);
  });

  it('自定义 provider 下未知 modelId → null', () => {
    const key = customProviderKey('acme');
    expect(resolveModel({ provider: key, modelId: 'nope' }, NO_CREDS, [customConfig])).toBeNull();
  });

  it('自定义 provider 未在列表中 → null', () => {
    const key = customProviderKey('ghost');
    expect(resolveModel({ provider: key, modelId: 'x' }, NO_CREDS, [customConfig])).toBeNull();
  });

  it('自定义 provider 不触发 openrouter / copilot 特例（无注入头）', () => {
    const key = customProviderKey('acme');
    const model = resolveModel({ provider: key, modelId: 'acme-fast' }, NO_CREDS, [customConfig]);
    expect(model!.headers?.['HTTP-Referer']).toBeUndefined();
  });
});

describe('resolveModel — built-in provider', () => {
  it('未知内置 provider → null', () => {
    expect(resolveModel({ provider: 'definitely-not-a-provider', modelId: 'x' }, NO_CREDS, NO_CUSTOM)).toBeNull();
  });

  it('已知 provider 下未知 modelId → null', () => {
    const id = firstModelId('openai');
    if (!id) return; // 目录为空则跳过
    expect(resolveModel({ provider: 'openai', modelId: '__no_such_model__' }, NO_CREDS, NO_CUSTOM)).toBeNull();
  });

  it('openrouter 注入 Cebian 归因头', () => {
    const id = firstModelId('openrouter');
    if (!id) return;
    const model = resolveModel({ provider: 'openrouter', modelId: id }, NO_CREDS, NO_CUSTOM);
    expect(model).not.toBeNull();
    expect(model!.headers?.['HTTP-Referer']).toBe('https://cebian.catcat.work');
    expect(model!.headers?.['X-Title']).toBe('Cebian');
  });

  it('非 openrouter provider 不注入归因头', () => {
    const id = firstModelId('openai');
    if (!id) return;
    const model = resolveModel({ provider: 'openai', modelId: id }, NO_CREDS, NO_CUSTOM);
    expect(model).not.toBeNull();
    expect(model!.headers?.['HTTP-Referer']).toBeUndefined();
  });
});

describe('resolveModel — github-copilot baseUrl', () => {
  it('OAuth 凭据存在时覆盖 baseUrl', () => {
    const id = firstModelId('github-copilot');
    if (!id) return;
    const cred: OAuthCredential = {
      authType: 'oauth',
      accessToken: 'tok_xxx',
      verified: true,
    };
    const creds: ProviderCredentials = { 'github-copilot': cred };
    const model = resolveModel({ provider: 'github-copilot', modelId: id }, creds, NO_CUSTOM);
    expect(model).not.toBeNull();
    expect(typeof model!.baseUrl).toBe('string');
    expect(model!.baseUrl!.length).toBeGreaterThan(0);
  });
});

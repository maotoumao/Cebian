import type { Api, Model } from '@mariozechner/pi-ai';
import type { CustomProviderConfig, CustomModelDef } from './storage';

/** Prefix used to distinguish custom providers from built-in ones */
export const CUSTOM_PREFIX = 'custom:';

/** Build a provider key for storage (e.g. "custom:deepseek") */
export function customProviderKey(id: string): string {
  return `${CUSTOM_PREFIX}${id}`;
}

/** Check if a provider key is a custom provider */
export function isCustomProvider(provider: string): boolean {
  return provider.startsWith(CUSTOM_PREFIX);
}

/** Extract the custom provider id from a provider key */
export function customProviderId(provider: string): string {
  return provider.slice(CUSTOM_PREFIX.length);
}

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 8192;

/** Convert a CustomProviderConfig + CustomModelDef into a pi-ai Model object */
export function toModel(config: CustomProviderConfig, model: CustomModelDef): Model<Api> {
  return {
    id: model.modelId,
    name: model.name,
    api: 'openai-completions' as Api,
    provider: customProviderKey(config.id),
    baseUrl: config.baseUrl,
    reasoning: model.reasoning,
    input: ['text'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

/** Get all Model objects for a custom provider */
export function getCustomModels(config: CustomProviderConfig): Model<Api>[] {
  return config.models.map(m => toModel(config, m));
}

/** Merge preset providers with user custom providers, deduplicating by id */
export function mergeCustomProviders(
  presets: readonly CustomProviderConfig[],
  userCustoms: CustomProviderConfig[],
): CustomProviderConfig[] {
  return [
    ...presets,
    ...userCustoms.filter(c => !presets.some(p => p.id === c.id)),
  ];
}

/** Find a custom provider config by provider key (e.g. "custom:deepseek") */
export function findCustomProvider(
  providers: CustomProviderConfig[],
  providerKey: string,
): CustomProviderConfig | undefined {
  if (!isCustomProvider(providerKey)) return undefined;
  const id = customProviderId(providerKey);
  return providers.find(p => p.id === id);
}

/** Find a specific model from custom providers */
export function findCustomModel(
  providers: CustomProviderConfig[],
  providerKey: string,
  modelId: string,
): Model<Api> | undefined {
  const config = findCustomProvider(providers, providerKey);
  if (!config) return undefined;
  const md = config.models.find(m => m.modelId === modelId);
  return md ? toModel(config, md) : undefined;
}

/** Fetch available models from an OpenAI-compatible /v1/models endpoint */
export async function fetchRemoteModels(
  baseUrl: string,
  apiKey: string,
): Promise<{ id: string; owned_by?: string }[]> {
  // Validate URL format
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('URL 格式无效');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('仅支持 http/https 协议');
  }

  const url = `${parsed.toString().replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`请求失败: ${res.status}`);
    }

    const data = await res.json();
    return data?.data ?? [];
  } finally {
    clearTimeout(timeoutId);
  }
}

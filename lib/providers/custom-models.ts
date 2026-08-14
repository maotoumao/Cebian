import type { Api, Model } from '@earendil-works/pi-ai';
import type { CustomProviderConfig, CustomModelDef } from '@/lib/persistence/storage';
import { t } from '@/lib/i18n';

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

export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 0;

/** Convert a CustomProviderConfig + CustomModelDef into a pi-ai Model object */
export function toModel(config: CustomProviderConfig, model: CustomModelDef): Model<Api> {
  const base: Model<Api> = {
    id: model.modelId,
    name: model.name,
    api: 'openai-completions' as Api,
    provider: customProviderKey(config.id),
    baseUrl: config.baseUrl,
    reasoning: model.reasoning,
    input: (model.image ? ['text', 'image'] : ['text']) as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
    // 自定义端点面向第三方 OpenAI 兼容 API，pi-ai 对未知 host 的默认值按 OpenAI 本家倾斜，
    // 这里逐项纠偏；getCompat 按字段覆盖，未列出的项不影响自动探测：
    // - supportsDeveloperRole: developer 角色只有 OpenAI 及其严格镜像认识（OpenAI 收到
    //   system 会自动为推理模型转换），第三方普遍直接 400，一律用 system (#46 #57)
    // - maxTokensField: 第三方普遍只认原始的 max_tokens，发 max_completion_tokens 会被
    //   静默忽略，导致「最大输出」设置不生效、被服务端默认上限截断 (#54)
    compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
  };
  // 用户自定义请求头并进 model.headers（pi-ai 会合并进请求头）；仅非空时附加
  if (config.headers && Object.keys(config.headers).length > 0) {
    base.headers = config.headers;
  }
  return base;
}

/** Get all Model objects for a custom provider */
export function getCustomModels(config: CustomProviderConfig): Model<Api>[] {
  return config.models.map(m => toModel(config, m));
}

/**
 * 重新拉取模型列表后按 modelId 合并：仍存在的模型保留既有配置（reasoning/image/
 * contextWindow/maxTokens），新模型以默认值补入，远端已消失的移除；顺序跟随远端、
 * 重复 id 只取首个。避免「自动获取」把用户设过的每模型配置整批冲掉
 */
export function mergeFetchedModels(
  existing: CustomModelDef[],
  fetchedIds: string[],
): CustomModelDef[] {
  const byId = new Map(existing.map(m => [m.modelId, m]));
  const seen = new Set<string>();
  const out: CustomModelDef[] = [];
  for (const id of fetchedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(byId.get(id) ?? { modelId: id, name: id, reasoning: false, image: false });
  }
  return out;
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
  headers?: Record<string, string>,
): Promise<{ id: string; owned_by?: string }[]> {
  // Validate URL format
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(t('errors.network.invalidUrl'));
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(t('errors.network.unsupportedScheme'));
  }

  const url = `${parsed.toString().replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    // 与运行时一致（apiKey 优先）：先铺自定义 header，apiKey 非空时再用它覆盖 authorization。
    // key 统一小写（headerRowsToRecord 输出即小写），避免 Authorization/authorization 大小写重复
    const requestHeaders: Record<string, string> = { ...(headers ?? {}) };
    if (apiKey) requestHeaders['authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(t('errors.network.requestFailed', [res.status]));
    }

    const data = await res.json();
    return data?.data ?? [];
  } finally {
    clearTimeout(timeoutId);
  }
}

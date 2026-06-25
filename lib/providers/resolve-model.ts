import type { Api, KnownProvider, Model } from '@earendil-works/pi-ai';
import { getModels } from '@earendil-works/pi-ai/compat';
import type {
  ModelIdentity,
  ProviderCredentials,
  CustomProviderConfig,
} from '@/lib/persistence/storage';
import { isCustomProvider, findCustomModel } from '@/lib/providers/custom-models';
import { getCopilotBaseUrl } from '@/lib/providers/oauth';

/**
 * 把一个模型身份（provider key + modelId）解析成可用的 pi-ai 运行时 `Model`。
 *
 * 纯函数：所有外部状态（凭据、自定义 provider 列表）都作参数传入，不读存储、不碰
 * 平台 API，因此可独立单测。读存储 + 全局兜底那一层留给调用方（见 agent-manager 的
 * `resolveSessionModel`）。
 *
 * 解析不出（未知内置 provider / 自定义模型查无 / modelId 不存在）时返回 null，由调用
 * 方决定如何「诚实报错」。custom provider 查表、copilot OAuth baseUrl、openrouter 归因
 * 头三条特例都在此处理，保证无论身份来自全局还是会话都一致。
 */
export function resolveModel(
  identity: ModelIdentity,
  creds: ProviderCredentials,
  customProviders: CustomProviderConfig[],
): Model<Api> | null {
  let model: Model<Api> | undefined;

  if (isCustomProvider(identity.provider)) {
    model = findCustomModel(customProviders, identity.provider, identity.modelId) ?? undefined;
  } else {
    try {
      const models = getModels(identity.provider as KnownProvider) as Model<Api>[];
      model = models.find((m) => m.id === identity.modelId);
    } catch {
      return null;
    }
  }
  if (!model) return null;

  if (identity.provider === 'github-copilot') {
    const cred = creds[identity.provider];
    if (cred?.authType === 'oauth') {
      model = { ...model, baseUrl: getCopilotBaseUrl(cred) };
    }
  }

  // OpenRouter app 归因：附带固定的 HTTP-Referer / X-Title，让请求在 OpenRouter 的
  // 应用榜单与各模型页的 Apps Tab 中归因到 Cebian。pi-ai 会把 model.headers 合并进
  // 请求头。仅对 openrouter 注入，不影响其它 provider；不含任何用户数据，只标明
  // 「该请求来自 Cebian」。
  if (identity.provider === 'openrouter') {
    model = {
      ...model,
      headers: {
        ...model.headers,
        'HTTP-Referer': 'https://cebian.catcat.work',
        'X-Title': 'Cebian',
      },
    };
  }

  return model;
}

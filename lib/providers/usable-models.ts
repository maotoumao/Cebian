import { getBuiltinModels, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelIdentity, ProviderCredentials, CustomProviderConfig } from '@/lib/persistence/storage';
import { isCustomProvider, getCustomModels, customProviderKey } from '@/lib/providers/custom-models';

/** 一组可选模型：同一 provider 下的全部模型 + 展示用 label。 */
export interface ModelGroup {
  provider: string;
  label: string;
  models: Model<Api>[];
}

/**
 * 按凭据 + 自定义 provider 推导出「当前可选的模型分组」。这是「什么算可用模型」的单一
 * 来源——ModelSelector 的下拉列表与 ChatPage 的「有无可用模型」判断共用，避免两份门控
 * 逻辑漂移。
 *
 * 门控规则：
 * - 自定义 provider 恒可见（API key 可选，未配置也应可见可选，见 issue #3）；
 * - 内置 pi-ai provider 按认证类型——apiKey 填了就可选（连通性测试失败也保存，见
 *   issue #10，verified 只代表「测试通过过」不应作门槛），oauth 要 verified。
 */
export function listUsableModelGroups(
  credentials: ProviderCredentials,
  customProviders: CustomProviderConfig[],
): ModelGroup[] {
  const groups: ModelGroup[] = [];
  const seen = new Set<string>();

  for (const config of customProviders) {
    const providerKey = customProviderKey(config.id);
    const models = getCustomModels(config);
    if (models.length > 0) {
      groups.push({ provider: providerKey, label: config.name, models });
      seen.add(providerKey);
    }
  }

  for (const [provider, cred] of Object.entries(credentials)) {
    const usable = cred.authType === 'apiKey' ? !!cred.apiKey : cred.verified;
    if (!usable) continue;
    // 自定义的已在上面处理
    if (isCustomProvider(provider)) continue;
    if (seen.has(provider)) continue;
    try {
      const models = getBuiltinModels(provider as BuiltinProvider) as Model<Api>[];
      if (models.length > 0) {
        groups.push({ provider, label: provider, models });
      }
    } catch {
      // Unknown provider, skip
    }
  }

  return groups;
}

/** 是否存在至少一个可选模型。用于空状态判断（有 → 引导选模型 / 无 → 引导去设置）。 */
export function hasUsableModel(
  credentials: ProviderCredentials,
  customProviders: CustomProviderConfig[],
): boolean {
  return listUsableModelGroups(credentials, customProviders).length > 0;
}

/**
 * 某个模型身份此刻是否还选得出来。与 `listUsableModelGroups` 同源，因此「下拉里有没有
 * 它」与「能不能用它发送」永远是同一个答案。
 *
 * 两种失效都覆盖：模型从 provider 的模型列表里消失（官方下架 / 自定义模型被删），以及
 * provider 的凭据被删或未验证——后者 `resolveModel` 依然能解析成 `Model`，请求却必然
 * 失败，所以不能拿它当判据（issue #62）。
 */
export function isUsableModel(
  identity: ModelIdentity,
  credentials: ProviderCredentials,
  customProviders: CustomProviderConfig[],
): boolean {
  return listUsableModelGroups(credentials, customProviders).some(
    (group) =>
      group.provider === identity.provider &&
      group.models.some((model) => model.id === identity.modelId),
  );
}

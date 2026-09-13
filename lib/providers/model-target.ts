// 「模型 + 凭证」的配对：后台辅助任务（上下文压缩摘要、自动生成标题）最终要用的调用目标。
// 读配置、解析模型、取 key 这些 IO 留在调用方（session-manager 的 resolveAuxiliaryModel），
// 这里只放纯判定，便于单测。

import type { Api, Model } from '@earendil-works/pi-ai';

/** 一次辅助调用最终要用的模型与凭证。`apiKey` 可能为 undefined（连主模型都没凭证），
 *  由调用方决定裸发还是放弃。 */
interface ModelTarget {
  model: Model<Api>;
  apiKey: string | undefined;
}

/**
 * 配置的目标可用（解析成功且凭证可用）就原样返回，否则返回 null 表示「回退主模型」。
 * 空串 apiKey 与 undefined 同样视为不可用。
 */
function usableModelTarget(configured: ModelTarget | null): ModelTarget | null {
  return configured && configured.apiKey ? configured : null;
}

export { usableModelTarget };
export type { ModelTarget };

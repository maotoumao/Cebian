// 内置模型目录 = pi-ai 自带目录 + 本地补丁（model-catalog-patch.json）。
//
// 为什么有补丁：pi 0.85–0.87 重写了 harness Session 存储层（落盘格式变化、未入 CHANGELOG），
// 并在 0.86 引入 Transcript 机制，暂不升级 pi；但新模型（GPT-6、Claude Opus 5.5 等）需要
// 现在就能选。补丁条目原样取自新版 pi-ai 的模型目录，只补上游还没收录的，同 provider + id
// 以上游为准。
//
// 这是临时层：升级 pi 后跑 builtin-models.test.ts，它会列出已被上游收录的补丁条目；全部收录后
// 删除本文件、model-catalog-patch.json 与测试，把调用方的 import 改回
// `@earendil-works/pi-ai/providers/all`（清单见 .agents/skills/upgrade-pi/SKILL.md）。

import type { Api, Model } from '@earendil-works/pi-ai';
import {
  getBuiltinModels as getPiBuiltinModels,
  type BuiltinProvider,
} from '@earendil-works/pi-ai/providers/all';
import catalogPatch from './model-catalog-patch.json';

// 补丁里的条目带有 0.84.4 类型不认识的字段（inputLimits / promptCache / compat.supportsMidConvo*），
// 运行时会被忽略；类型断言只收在这一处。
const PATCH_MODELS = catalogPatch.models as unknown as Partial<Record<string, Model<Api>[]>>;
const HIDDEN_MODEL_IDS = catalogPatch.hidden as Partial<Record<string, string[]>>;

/**
 * 某个内置 provider 的全部模型：pi 目录（去掉上游已下架但本地版本还列着的）+ 上游尚未收录的补丁
 * 条目（追加在后）。未知 provider 与 pi 一致返回空数组。
 */
function getBuiltinModels(provider: BuiltinProvider): Model<Api>[] {
  const hidden = new Set(HIDDEN_MODEL_IDS[provider] ?? []);
  const upstream = (getPiBuiltinModels(provider) as Model<Api>[]).filter((m) => !hidden.has(m.id));
  const known = new Set(upstream.map((m) => m.id));
  const patched = (PATCH_MODELS[provider] ?? []).filter((m) => !known.has(m.id));
  return patched.length > 0 ? [...upstream, ...patched] : upstream;
}

export type { BuiltinProvider };
export { getBuiltinModels };

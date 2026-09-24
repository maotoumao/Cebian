import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { Api, Model } from '@earendil-works/pi-ai';
import { getApiProvider } from '@earendil-works/pi-ai/compat';
import {
  getBuiltinModels as getPiBuiltinModels,
  type BuiltinProvider,
} from '@earendil-works/pi-ai/providers/all';
import { getBuiltinModels } from '@/lib/providers/builtin-models';
import catalogPatch from '@/lib/providers/model-catalog-patch.json';

// 模型目录补丁的护栏。升级 pi 后这里失败，是在提示「补丁有条目该删了」，而不是补丁坏了：
// 按失败信息删掉对应条目；models 与 hidden 都清空后，删除 model-catalog-patch.json、
// builtin-models.ts 与本测试，调用方 import 改回 '@earendil-works/pi-ai/providers/all'。

const patchModels = catalogPatch.models as unknown as Record<string, Model<Api>[]>;
const hidden = catalogPatch.hidden as Record<string, string[]>;
const pi = (provider: string) => getPiBuiltinModels(provider as BuiltinProvider) as Model<Api>[];

// pi-ai 的 exports 没有暴露 ./package.json，直接读安装目录
const installedPiVersion = (
  JSON.parse(readFileSync('node_modules/@earendil-works/pi-ai/package.json', 'utf8')) as { version: string }
).version;

/** 比较正式版 x.y.z；预发布 / 构建后缀等其他格式直接报错，免得被误判成「该删补丁」。 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`不支持的版本格式：${v}（只比较 x.y.z，请手动判断补丁是否过时）`);
    return v.split('.').map(Number);
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

describe('model-catalog-patch', () => {
  it('已安装的 pi 早于补丁来源版本（否则整份补丁已过时）', () => {
    // 升到来源版本或更新后，上游要么已收录、要么有意删除了这些条目，逐条比对 id 已不可靠
    expect(
      compareVersions(installedPiVersion, catalogPatch.sourceVersion),
      `pi-ai ${installedPiVersion} ≥ 补丁来源 ${catalogPatch.sourceVersion}：删除 model-catalog-patch.json、`
        + `builtin-models.ts 与本测试，import 改回 '@earendil-works/pi-ai/providers/all'`,
    ).toBeLessThan(0);
  });

  it('补丁条目都还没被 pi 收录（被收录的请从补丁删除）', () => {
    const superseded = Object.entries(patchModels).flatMap(([provider, models]) =>
      models.filter((m) => pi(provider).some((u) => u.id === m.id)).map((m) => `${provider}/${m.id}`),
    );
    expect(superseded, `pi 已收录，删除这些补丁条目：${superseded.join(', ')}`).toEqual([]);
  });

  it('隐藏的模型都还在 pi 目录里（上游已删的请从 hidden 删除）', () => {
    const stale = Object.entries(hidden).flatMap(([provider, ids]) =>
      ids.filter((id) => !pi(provider).some((u) => u.id === id)).map((id) => `${provider}/${id}`),
    );
    expect(stale, `pi 已移除，删除这些 hidden 条目：${stale.join(', ')}`).toEqual([]);
  });

  it('补丁条目归属的 provider 是已知内置 provider，provider 字段一致，id 不重复', () => {
    for (const [provider, models] of Object.entries(patchModels)) {
      expect(pi(provider).length, provider).toBeGreaterThan(0);
      expect(new Set(models.map((m) => m.id)).size, provider).toBe(models.length);
      for (const m of models) expect(m.provider, `${provider}/${m.id}`).toBe(provider);
    }
  });

  it('补丁条目用到的 api 在当前 pi 都有已注册的适配器', () => {
    for (const models of Object.values(patchModels)) {
      for (const m of models) expect(getApiProvider(m.api), `${m.provider}/${m.id}: ${m.api}`).toBeTruthy();
    }
  });

  it('唯一一处偏离上游：Codex 的 GPT-6 Sol / Luna 不提供「关闭思考」', () => {
    // pi-ai 0.84.4 的 Codex 适配器选 off 时不发送 effort，模型会按服务端默认继续推理；
    // 0.86.0 起改为发送 'none'。所以只在 0.86.0 之前偏离；升到 0.86.x–0.87.0 而补丁还在时，
    // 要把 off 改回上游的 'none'。这两条已从补丁删除时，本断言自然不再适用。
    const needsDeviation = compareVersions(installedPiVersion, '0.86.0') < 0;
    for (const id of ['gpt-6-sol', 'gpt-6-luna']) {
      const entry = patchModels['openai-codex']?.find((m) => m.id === id);
      if (!entry) continue;
      expect(
        entry.thinkingLevelMap?.off,
        needsDeviation ? `${id}：pi < 0.86.0，off 应为 null` : `${id}：pi ≥ 0.86.0，off 改回上游的 'none'`,
      ).toBe(needsDeviation ? null : 'none');
    }
  });
});

describe('getBuiltinModels', () => {
  it('上游在前（去掉 hidden）、补丁追加在后，不重复', () => {
    for (const provider of new Set([...Object.keys(patchModels), ...Object.keys(hidden)])) {
      const merged = getBuiltinModels(provider as BuiltinProvider).map((m) => m.id);
      const hiddenIds = hidden[provider] ?? [];
      const upstream = pi(provider).map((m) => m.id).filter((id) => !hiddenIds.includes(id));
      expect(merged.slice(0, upstream.length), provider).toEqual(upstream);
      for (const m of patchModels[provider] ?? []) expect(merged, provider).toContain(m.id);
      for (const id of hiddenIds) expect(merged, provider).not.toContain(id);
      expect(new Set(merged).size, provider).toBe(merged.length);
    }
  });

  it('没有补丁的 provider 原样返回 pi 目录；未知 provider 返回空数组', () => {
    expect(getBuiltinModels('groq').map((m) => m.id)).toEqual(pi('groq').map((m) => m.id));
    expect(getBuiltinModels('no-such-provider' as BuiltinProvider)).toEqual([]);
  });
});

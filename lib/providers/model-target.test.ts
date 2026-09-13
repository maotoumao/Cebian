import { describe, it, expect } from 'vitest';
import type { Api, Model } from '@earendil-works/pi-ai';
import { usableModelTarget, type ModelTarget } from '@/lib/providers/model-target';

/** 构造一个最小可辨识的 Model：只需 id / provider 用于断言「选中了哪个」。 */
function fakeModel(id: string, provider: string): Model<Api> {
  return { id, provider } as unknown as Model<Api>;
}

const smallModel = fakeModel('small', 'custom:cheap');

describe('usableModelTarget', () => {
  it('未配置（configured 为 null）→ null（回退主模型）', () => {
    expect(usableModelTarget(null)).toBeNull();
  });

  it('配置了模型且凭证可用 → 原样返回该目标', () => {
    const configured: ModelTarget = { model: smallModel, apiKey: 'small-key' };
    expect(usableModelTarget(configured)).toBe(configured);
  });

  it('配置了模型但无凭证（apiKey undefined）→ null（回退主模型）', () => {
    const configured: ModelTarget = { model: smallModel, apiKey: undefined };
    expect(usableModelTarget(configured)).toBeNull();
  });

  it('配置了模型但 apiKey 为空串 → null（回退主模型）', () => {
    const configured: ModelTarget = { model: smallModel, apiKey: '' };
    expect(usableModelTarget(configured)).toBeNull();
  });
});

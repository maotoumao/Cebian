import { describe, it, expect } from 'vitest';
import {
  ORCAROUTER_MODELS,
  ORCAROUTER_PROVIDER,
  ORCAROUTER_BASE_URL,
  findOrcaRouterModel,
} from '@/lib/providers/orcarouter';

describe('orcarouter catalog', () => {
  it('models point at the OrcaRouter OpenAI-compatible endpoint', () => {
    for (const m of ORCAROUTER_MODELS) {
      expect(m.provider).toBe(ORCAROUTER_PROVIDER);
      expect(m.baseUrl).toBe(ORCAROUTER_BASE_URL);
      expect(m.api).toBe('openai-completions');
    }
  });

  it('models carry the Cebian attribution headers', () => {
    for (const m of ORCAROUTER_MODELS) {
      expect(m.headers?.['HTTP-Referer']).toBe('https://cebian.catcat.work');
      expect(m.headers?.['X-Title']).toBe('Cebian');
    }
  });

  it('includes the documented auto-routing entry', () => {
    expect(findOrcaRouterModel('orcarouter/auto')).toBeDefined();
  });

  it('unknown model id → undefined', () => {
    expect(findOrcaRouterModel('nope/nope')).toBeUndefined();
  });
});

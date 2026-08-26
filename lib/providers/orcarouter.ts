// ─── OrcaRouter provider catalog ───

import type { Api, Model } from '@earendil-works/pi-ai';

export const ORCAROUTER_PROVIDER = 'orcarouter';
export const ORCAROUTER_BASE_URL = 'https://api.orcarouter.ai/v1';

// Cebian attribution headers, mirroring the OpenRouter integration. OrcaRouter
// accepts HTTP-Referer / X-Title on its OpenAI-compatible endpoint so requests
// are attributed back to Cebian in its request log.
const ORCAROUTER_HEADERS = {
  'HTTP-Referer': 'https://cebian.catcat.work',
  'X-Title': 'Cebian',
} as const;

function orcaRouterModel(
  id: string,
  name: string,
  reasoning: boolean,
): Model<Api> {
  return {
    id,
    name,
    api: 'openai-completions',
    provider: ORCAROUTER_PROVIDER,
    baseUrl: ORCAROUTER_BASE_URL,
    reasoning,
    // Routing models forward to whatever upstream the gateway picks, so the
    // safest capability set is text-only — an image request could otherwise be
    // routed to a text-only upstream and fail.
    input: ['text'],
    // The gateway's pricing depends on the upstream it routes to, which Cebian
    // cannot know ahead of time; zero cost keeps these out of "cheapest model"
    // heuristics without inventing numbers.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    // No fixed output cap — let the per-request maxTokens setting decide.
    maxTokens: 0,
    headers: { ...ORCAROUTER_HEADERS },
    // OrcaRouter speaks the same reasoning format as OpenRouter (top-level
    // `reasoning: { effort }`), so reasoning-capable models use that compat.
    ...(reasoning ? { compat: { thinkingFormat: 'openrouter' as const } } : {}),
  };
}

/**
 * The native OrcaRouter routing models. These are the unique value of the
 * gateway: they auto-route across upstream vendors instead of pinning one, so
 * they belong here as a first-class provider. Vendor-prefixed models (e.g.
 * `deepseek/deepseek-chat`) are intentionally omitted — Cebian already ships
 * dedicated providers for those vendors, and OrcaRouter exposes hundreds of
 * them with no per-model metadata to curate against.
 */
export const ORCAROUTER_MODELS: Model<Api>[] = [
  orcaRouterModel('orcarouter/auto', 'OrcaRouter Auto', true),
  orcaRouterModel('orcarouter/free', 'OrcaRouter Free', false),
  orcaRouterModel('orcarouter/fusion', 'OrcaRouter Fusion', true),
  orcaRouterModel('orcarouter/fusion-flash', 'OrcaRouter Fusion Flash', true),
  orcaRouterModel('orcarouter/fusion-mini', 'OrcaRouter Fusion Mini', true),
];

export function findOrcaRouterModel(modelId: string): Model<Api> | undefined {
  return ORCAROUTER_MODELS.find((m) => m.id === modelId);
}

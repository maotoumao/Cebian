import { customProviders, providerCredentials, lastSelectedModel } from '@/lib/persistence/storage';
import { customProviderKey } from '@/lib/providers/custom-models';

// ─── Dev-only storage seed ───
//
// On background startup in dev mode (`pnpm dev`), if the user has filled
// `WXT_DEV_API_KEY` (and the required companions) in `.env.local`, this
// auto-creates a custom OpenAI-compatible provider with the fixed id `dev`
// so devs can skip the manual setup wizard on a fresh install.
//
// Production builds short-circuit immediately — none of this code path runs.
//
// Semantics: never overwrite user data.
//   - If a provider with id `dev` already exists, the entire seed is
//     skipped (the user may have edited it; we don't know).
//   - `lastSelectedModel` is only set when nothing is currently selected.
//
// The provider id is intentionally fixed (`dev`) rather than configurable:
// keeping it stable means re-running `pnpm dev` doesn't accumulate stale
// providers, and the "already exists" check has a single source of truth.
//
// Write order is also intentional: credentials → lastSelectedModel → provider.
// The provider entry doubles as our "already seeded" flag, so we write it
// LAST. Any crash mid-seed leaves the guard "unseeded" and the next launch
// retries cleanly from scratch instead of leaving orphan state.

const PROVIDER_ID = 'dev';
const CREDENTIALS_KEY = customProviderKey(PROVIDER_ID);

function parseBool(raw: string | undefined): boolean {
  return ['true', '1', 'yes'].includes((raw ?? '').trim().toLowerCase());
}

export async function seedDevStorage(): Promise<void> {
  if (!import.meta.env.DEV) return;

  const apiKey = import.meta.env.WXT_DEV_API_KEY?.trim();
  const baseUrl = import.meta.env.WXT_DEV_BASE_URL?.trim();
  const modelId = import.meta.env.WXT_DEV_MODEL_ID?.trim();

  // API key is the gate. Without it, the user hasn't opted in.
  if (!apiKey) return;

  if (!baseUrl || !modelId) {
    console.warn(
      '[dev-seed] WXT_DEV_API_KEY is set but WXT_DEV_BASE_URL or WXT_DEV_MODEL_ID is missing; skipping seed.',
    );
    return;
  }

  const existing = await customProviders.getValue();
  if (existing.some(p => p.id === PROVIDER_ID)) {
    // Already seeded (or user created their own with the same id). Don't touch.
    return;
  }

  const providerName = import.meta.env.WXT_DEV_PROVIDER_NAME?.trim() || 'Dev Provider';
  const modelName = import.meta.env.WXT_DEV_MODEL_NAME?.trim() || modelId;
  const reasoning = parseBool(import.meta.env.WXT_DEV_MODEL_REASONING);

  // Write credentials first (idempotent — same key overwrites cleanly on retry).
  const credentials = await providerCredentials.getValue();
  await providerCredentials.setValue({
    ...credentials,
    [CREDENTIALS_KEY]: {
      authType: 'apiKey',
      apiKey,
      verified: true,
    },
  });

  // Only auto-select if the user hasn't picked anything yet.
  const currentActive = await lastSelectedModel.getValue();
  if (!currentActive) {
    await lastSelectedModel.setValue({ provider: CREDENTIALS_KEY, modelId });
  }

  // Provider entry is written LAST: it's the "seeded" flag the guard above checks.
  await customProviders.setValue([
    ...existing,
    {
      id: PROVIDER_ID,
      name: providerName,
      baseUrl,
      models: [{ modelId, name: modelName, reasoning }],
    },
  ]);

  console.log(`[dev-seed] Seeded provider "${providerName}" (id=${PROVIDER_ID}) from .env.local`);
}



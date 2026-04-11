import { storage } from '#imports';

// ─── Provider credential types ───

export interface ApiKeyCredential {
  authType: 'apiKey';
  apiKey: string;
  verified: boolean;
}

export interface OAuthCredential {
  authType: 'oauth';
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  verified: boolean;
  extra?: Record<string, unknown>;
}

export type ProviderCredential = ApiKeyCredential | OAuthCredential;

export type ProviderCredentials = Record<string, ProviderCredential>;

// ─── Active model ───

export interface ActiveModel {
  provider: string;
  modelId: string;
}

// ─── Custom providers (OpenAI-compatible) ───

export interface CustomModelDef {
  modelId: string;
  name: string;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface CustomProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  models: CustomModelDef[];
}

// ─── Thinking level ───

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high';

// ─── Settings ───

export interface BehaviorSettings {
  confirmBeforeExec: boolean;
  streaming: boolean;
  backgroundPersist: boolean;
}

export interface CebianSettings {
  behavior: BehaviorSettings;
}

export const DEFAULT_SETTINGS: CebianSettings = {
  behavior: { confirmBeforeExec: true, streaming: true, backgroundPersist: true },
};

// ─── Storage items (WXT defineItem) ───

export const providerCredentials = storage.defineItem<ProviderCredentials>(
  'local:providerCredentials',
  { fallback: {} },
);

export const activeModel = storage.defineItem<ActiveModel | null>(
  'local:activeModel',
  { fallback: null },
);

export const customProviders = storage.defineItem<CustomProviderConfig[]>(
  'local:customProviders',
  { fallback: [] },
);

export const thinkingLevel = storage.defineItem<ThinkingLevel>(
  'local:thinkingLevel',
  { fallback: 'medium' },
);

export const themePreference = storage.defineItem<'dark' | 'light'>(
  'local:theme',
  { fallback: 'dark' },
);

export const cebianSettings = storage.defineItem<CebianSettings>(
  'local:settings',
  { fallback: DEFAULT_SETTINGS },
);

export const systemPrompt = storage.defineItem<string>(
  'local:systemPrompt',
  { fallback: '' },
);

export const maxRounds = storage.defineItem<number>(
  'local:maxRounds',
  { fallback: 200 },
);

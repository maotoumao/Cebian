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
}

export type ProviderCredential = ApiKeyCredential | OAuthCredential;

export type ProviderCredentials = Record<string, ProviderCredential>;

// ─── Active model ───

export interface ActiveModel {
  provider: string;
  modelId: string;
}

// ─── Thinking level ───

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high';

// ─── Settings ───

export interface ProxySettings {
  enabled: boolean;
  url: string;
}

export interface BehaviorSettings {
  confirmBeforeExec: boolean;
  streaming: boolean;
  backgroundPersist: boolean;
}

export interface CebianSettings {
  proxy: ProxySettings;
  behavior: BehaviorSettings;
}

// ─── Storage items (WXT defineItem) ───

export const providerCredentials = storage.defineItem<ProviderCredentials>(
  'local:providerCredentials',
  { fallback: {} },
);

export const activeModel = storage.defineItem<ActiveModel | null>(
  'local:activeModel',
  { fallback: null },
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
  {
    fallback: {
      proxy: { enabled: false, url: '' },
      behavior: { confirmBeforeExec: true, streaming: true, backgroundPersist: true },
    },
  },
);

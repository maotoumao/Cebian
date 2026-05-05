/**
 * OAuth login/refresh logic for browser extension context.
 *
 * GitHub Copilot: Device Code Flow (uses pi-ai directly)
 * OpenAI Codex:   Authorization Code + PKCE (self-built, tab URL interception)
 */

import {
  loginGitHubCopilot as piLoginGitHubCopilot,
  refreshGitHubCopilotToken,
  refreshOpenAICodexToken,
  getGitHubCopilotBaseUrl,
  normalizeDomain,
} from '@mariozechner/pi-ai/oauth';
import { providerCredentials, type OAuthCredential } from './storage';
import { t } from '@/lib/i18n';

// ─── PKCE (Web Crypto) ───

function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const challenge = base64urlEncode(new Uint8Array(hash));
  return { verifier, challenge };
}

// ─── Result type ───

export interface OAuthResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  extra?: Record<string, unknown>;
}

// ─── Tab URL interception ───

function waitForRedirectUrl(
  urlPrefix: string,
  signal?: AbortSignal,
  timeoutMs = 120000,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(t('errors.oauth.cancelled')));
      return;
    }

    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    };

    const listener = (tabId: number, info: { url?: string }) => {
      if (info.url?.startsWith(urlPrefix)) {
        cleanup();
        chrome.tabs.remove(tabId).catch(() => {});
        resolve(info.url);
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(t('errors.oauth.timeout')));
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(listener);

    signal?.addEventListener('abort', () => {
      cleanup();
      reject(new Error(t('errors.oauth.cancelled')));
    }, { once: true });
  });
}

// ─── GitHub Copilot (Device Code Flow) ───

export interface GitHubCopilotCallbacks {
  onDeviceCode: (code: string, verificationUrl: string) => void;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export async function loginGitHubCopilot(
  callbacks: GitHubCopilotCallbacks,
): Promise<OAuthResult> {
  const creds = await piLoginGitHubCopilot({
    onAuth: (url: string, instructions?: string) => {
      chrome.tabs.create({ url });
      callbacks.onDeviceCode(instructions ?? '', url);
    },
    onPrompt: async () => '',
    onProgress: callbacks.onProgress,
    signal: callbacks.signal,
  });

  return {
    accessToken: creds.access,
    refreshToken: creds.refresh,
    expiresAt: creds.expires,
    extra: creds.enterpriseUrl ? { enterpriseUrl: creds.enterpriseUrl } : undefined,
  };
}

// ─── OpenAI Codex (Authorization Code + PKCE) ───

const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const OPENAI_SCOPE = 'openid profile email offline_access';

export async function loginOpenAICodex(
  signal?: AbortSignal,
): Promise<OAuthResult> {
  const { verifier, challenge } = await generatePKCE();
  const state = crypto.randomUUID();

  const url = new URL(OPENAI_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OPENAI_CLIENT_ID);
  url.searchParams.set('redirect_uri', OPENAI_REDIRECT_URI);
  url.searchParams.set('scope', OPENAI_SCOPE);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('codex_cli_simplified_flow', 'true');

  chrome.tabs.create({ url: url.toString() });

  const redirectUrl = await waitForRedirectUrl(OPENAI_REDIRECT_URI, signal);
  const params = new URL(redirectUrl).searchParams;
  const code = params.get('code');
  const returnedState = params.get('state');

  if (!code) throw new Error(t('errors.oauth.noCode'));
  if (returnedState !== state) throw new Error(t('errors.oauth.stateMismatch'));

  // Exchange code for tokens
  const tokenRes = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: OPENAI_REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(t('errors.oauth.tokenExchangeFailed', [tokenRes.status]));
  }

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token || !tokenData.refresh_token) {
    throw new Error(t('errors.oauth.missingTokenFields'));
  }

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: Date.now() + tokenData.expires_in * 1000,
  };
}

// ─── Unified refresh ───

export async function refreshOAuthCredential(
  provider: string,
  cred: OAuthCredential,
): Promise<OAuthCredential> {
  if (!cred.refreshToken) throw new Error(t('errors.oauth.missingRefreshTokenLocal'));

  let newAccess: string;
  let newRefresh: string;
  let newExpires: number;
  let newExtra = cred.extra;

  switch (provider) {
    case 'github-copilot': {
      const domain = cred.extra?.enterpriseUrl
        ? (normalizeDomain(cred.extra.enterpriseUrl as string) ?? undefined)
        : undefined;
      const result = await refreshGitHubCopilotToken(cred.refreshToken, domain);
      newAccess = result.access;
      newRefresh = result.refresh;
      newExpires = result.expires;
      if (result.enterpriseUrl) {
        newExtra = { ...cred.extra, enterpriseUrl: result.enterpriseUrl };
      }
      break;
    }
    case 'openai-codex': {
      const result = await refreshOpenAICodexToken(cred.refreshToken);
      newAccess = result.access;
      newRefresh = result.refresh;
      newExpires = result.expires;
      break;
    }
    default:
      throw new Error(t('errors.oauth.unknownProvider', [provider]));
  }

  return {
    authType: 'oauth',
    accessToken: newAccess,
    refreshToken: newRefresh,
    expiresAt: newExpires,
    verified: true,
    extra: newExtra,
  };
}

// ─── Get Copilot base URL ───

export function getCopilotBaseUrl(cred: OAuthCredential): string {
  const domain = cred.extra?.enterpriseUrl
    ? (normalizeDomain(cred.extra.enterpriseUrl as string) ?? undefined)
    : undefined;
  return getGitHubCopilotBaseUrl(cred.accessToken, domain);
}

// ─── On-demand token refresh ───

const ON_DEMAND_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry

/** Per-provider in-flight refresh promise to deduplicate concurrent refreshes. */
const inflightRefresh = new Map<string, Promise<OAuthCredential>>();

/**
 * Get a valid OAuth token, refreshing on-demand if it's about to expire.
 * Deduplicates concurrent refresh requests per provider.
 */
export async function getValidOAuthToken(
  provider: string,
  _cred: OAuthCredential,
): Promise<string> {
  // Re-read from storage in case background alarm already refreshed
  const freshCreds = await providerCredentials.getValue();
  const cred = (freshCreds[provider] as OAuthCredential | undefined) ?? _cred;

  if (cred.refreshToken && cred.expiresAt && Date.now() >= cred.expiresAt - ON_DEMAND_BUFFER_MS) {
    let pending = inflightRefresh.get(provider);
    if (!pending) {
      pending = refreshOAuthCredential(provider, cred)
        .then(async (refreshed) => {
          const creds = await providerCredentials.getValue();
          await providerCredentials.setValue({ ...creds, [provider]: refreshed });
          console.log(`[OAuth] ${provider}: on-demand refresh succeeded`);
          return refreshed;
        })
        .finally(() => inflightRefresh.delete(provider));
      inflightRefresh.set(provider, pending);
    }

    try {
      const refreshed = await pending;
      return refreshed.accessToken;
    } catch (err) {
      console.error(`[OAuth] ${provider}: on-demand refresh failed, using existing token`, err);
    }
  }

  return cred.accessToken;
}

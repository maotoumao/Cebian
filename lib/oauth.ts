/**
 * OAuth login/refresh logic for browser extension context.
 *
 * GitHub Copilot: Device Code Flow (uses pi-ai directly)
 * OpenAI Codex:   Authorization Code + PKCE (self-built, tab URL interception)
 * Google Gemini:  Authorization Code + PKCE (self-built, tab URL interception)
 */

import {
  loginGitHubCopilot as piLoginGitHubCopilot,
  refreshGitHubCopilotToken,
  refreshOpenAICodexToken,
  refreshGoogleCloudToken,
} from '@mariozechner/pi-ai/oauth';
import type { OAuthCredential } from './storage';

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
      reject(new Error('已取消'));
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
      reject(new Error('授权超时'));
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(listener);

    signal?.addEventListener('abort', () => {
      cleanup();
      reject(new Error('已取消'));
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

  if (!code) throw new Error('未收到授权码');
  if (returnedState !== state) throw new Error('State 不匹配');

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
    throw new Error(`Token 交换失败: ${tokenRes.status}`);
  }

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token || !tokenData.refresh_token) {
    throw new Error('Token 响应缺少必要字段');
  }

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: Date.now() + tokenData.expires_in * 1000,
  };
}

// ─── Google Gemini CLI (Authorization Code + PKCE) ───

const GOOGLE_CLIENT_ID = atob('NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t');
const GOOGLE_CLIENT_SECRET = atob('R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw=');
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REDIRECT_URI = 'http://localhost:8085/oauth2callback';
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';

async function discoverGoogleProject(accessToken: string): Promise<string> {
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'cebian-extension/1.0',
  };

  const loadRes = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
      },
    }),
  });

  if (loadRes.ok) {
    const data = await loadRes.json();
    if (data.cloudaicompanionProject) {
      return data.cloudaicompanionProject;
    }
    if (data.currentTier) {
      // Has tier but no managed project — need onboarding
    }
  }

  // Onboard to free tier
  const onboardRes = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      tierId: 'free-tier',
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
      },
    }),
  });

  if (!onboardRes.ok) {
    throw new Error(`Google Cloud 项目配置失败: ${onboardRes.status}`);
  }

  let lroData = await onboardRes.json();

  // Poll if operation is not done
  if (!lroData.done && lroData.name) {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const pollRes = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal/${lroData.name}`, {
        method: 'GET',
        headers,
      });
      if (!pollRes.ok) throw new Error('项目配置轮询失败');
      lroData = await pollRes.json();
      if (lroData.done) break;
    }
  }

  const projectId = lroData.response?.cloudaicompanionProject?.id;
  if (projectId) return projectId;

  throw new Error('无法获取 Google Cloud 项目 ID');
}

export async function loginGeminiCli(
  signal?: AbortSignal,
): Promise<OAuthResult> {
  const { verifier, challenge } = await generatePKCE();
  const state = crypto.randomUUID();

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', GOOGLE_REDIRECT_URI);
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');

  chrome.tabs.create({ url: url.toString() });

  const redirectUrl = await waitForRedirectUrl(GOOGLE_REDIRECT_URI, signal);
  const params = new URL(redirectUrl).searchParams;
  const code = params.get('code');
  const returnedState = params.get('state');

  if (!code) throw new Error('未收到授权码');
  if (returnedState !== state) throw new Error('State 不匹配');

  // Exchange code for tokens
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: GOOGLE_REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Token 交换失败: ${tokenRes.status}`);
  }

  const tokenData = await tokenRes.json();
  if (!tokenData.refresh_token) {
    throw new Error('未收到 refresh token');
  }

  // Discover / provision Google Cloud project
  const projectId = await discoverGoogleProject(tokenData.access_token);

  // Get user email (optional)
  let email: string | undefined;
  try {
    const userRes = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
    });
    if (userRes.ok) {
      const userData = await userRes.json();
      email = userData.email;
    }
  } catch { /* optional */ }

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
    extra: { projectId, email },
  };
}

// ─── Unified refresh ───

export async function refreshOAuthCredential(
  provider: string,
  cred: OAuthCredential,
): Promise<OAuthCredential> {
  if (!cred.refreshToken) throw new Error('缺少 refresh token');

  let newAccess: string;
  let newRefresh: string;
  let newExpires: number;
  let newExtra = cred.extra;

  switch (provider) {
    case 'github-copilot': {
      const result = await refreshGitHubCopilotToken(cred.refreshToken);
      newAccess = result.access;
      newRefresh = result.refresh;
      newExpires = result.expires;
      break;
    }
    case 'openai-codex': {
      const result = await refreshOpenAICodexToken(cred.refreshToken);
      newAccess = result.access;
      newRefresh = result.refresh;
      newExpires = result.expires;
      break;
    }
    case 'google-gemini-cli': {
      const projectId = (cred.extra?.projectId as string) ?? '';
      const result = await refreshGoogleCloudToken(cred.refreshToken, projectId);
      newAccess = result.access;
      newRefresh = result.refresh;
      newExpires = result.expires;
      newExtra = { ...cred.extra, projectId: result.projectId ?? projectId };
      break;
    }
    default:
      throw new Error(`未知的 OAuth provider: ${provider}`);
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

// ─── Get API key (with auto-refresh if expired) ───

export function getApiKeyFromCredential(
  provider: string,
  cred: OAuthCredential,
): string {
  if (provider === 'google-gemini-cli') {
    return JSON.stringify({
      token: cred.accessToken,
      projectId: cred.extra?.projectId,
    });
  }
  return cred.accessToken;
}

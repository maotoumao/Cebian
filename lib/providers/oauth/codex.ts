/**
 * OpenAI Codex OAuth —— Authorization Code + PKCE，自建 tab URL 拦截，浏览器安全。
 *
 * 登录流程是 Cebian 自建的（pi 的 Codex 登录用 `node:http` 本地回调服务器，扩展里跑不了，
 * 一直是我们自己实现）。刷新此前借用 pi 的 `refreshOpenAICodexToken`，pi 0.80.8 起也移除了，
 * 故一并 vendored。实现 pi 的 `OAuthAuth` 接口，便于将来直接接入 pi 的 `createModels()`。
 *
 * 刷新的 token 端点与参数 vendored 自 pi-ai（MIT, Mario Zechner），完整许可见 ./copilot.ts 头部。
 */
import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai';
import { t } from '@/lib/i18n';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const SCOPE = 'openid profile email offline_access';

// ─── PKCE（Web Crypto） ───

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

// ─── tab URL 拦截 ───

function waitForRedirectUrl(
  urlPrefix: string,
  tabId: number,
  signal: AbortSignal,
  timeoutMs = 120000,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(t('errors.oauth.cancelled')));
      return;
    }

    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      signal.removeEventListener('abort', onAbort);
    };

    const listener = (updatedTabId: number, info: { url?: string }) => {
      if (updatedTabId === tabId && info.url?.startsWith(urlPrefix)) {
        cleanup();
        resolve(info.url);
      }
    };

    const onAbort = () => {
      cleanup();
      reject(new Error(t('errors.oauth.cancelled')));
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(t('errors.oauth.timeout')));
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(listener);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function readTokens(response: Response): Promise<OAuthCredential> {
  if (!response.ok) {
    throw new Error(t('errors.oauth.tokenExchangeFailed', [response.status]));
  }
  const data = (await response.json()) as Record<string, unknown>;
  const access = data.access_token;
  const refresh = data.refresh_token;
  const expiresIn = data.expires_in;
  if (
    typeof access !== 'string' ||
    !access ||
    typeof refresh !== 'string' ||
    !refresh ||
    typeof expiresIn !== 'number' ||
    !Number.isFinite(expiresIn)
  ) {
    throw new Error(t('errors.oauth.missingTokenFields'));
  }
  return {
    type: 'oauth',
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000,
  };
}

// ─── provider-owned OAuthAuth（pi 接口） ───

export const codexOAuth: OAuthAuth = {
  name: 'OpenAI Codex',

  async login(interaction) {
    const { verifier, challenge } = await generatePKCE();
    const state = crypto.randomUUID();

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('codex_cli_simplified_flow', 'true');

    const tab = await chrome.tabs.create({ url: url.toString() });
    if (typeof tab.id !== 'number') throw new Error('OAuth authorization tab has no id');
    try {
      const redirectUrl = await waitForRedirectUrl(REDIRECT_URI, tab.id, interaction.signal);
      const params = new URL(redirectUrl).searchParams;
      const code = params.get('code');
      const returnedState = params.get('state');
      if (!code) throw new Error(t('errors.oauth.noCode'));
      if (returnedState !== state) throw new Error(t('errors.oauth.stateMismatch'));

      return readTokens(
        await fetch(TOKEN_URL, {
          method: 'POST',
          signal: interaction.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            code,
            code_verifier: verifier,
            redirect_uri: REDIRECT_URI,
          }),
        }),
      );
    } finally {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  },

  async refresh(credential, signal) {
    return readTokens(
      await fetch(TOKEN_URL, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: credential.refresh,
          client_id: CLIENT_ID,
        }),
      }),
    );
  },

  async toAuth(credential) {
    return { apiKey: credential.access };
  },
};

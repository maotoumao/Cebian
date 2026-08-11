/**
 * OAuth 公共出口 —— 对外保持与旧 `lib/providers/oauth.ts` 逐字一致的 API，内部改为委托
 * vendored 的 provider-owned `OAuthAuth`（见 copilot.ts / codex.ts）+ 凭证适配（credential.ts）。
 *
 * GitHub Copilot：设备码流。OpenAI Codex：Authorization Code + PKCE + tab 拦截。
 * 两者均为浏览器安全的纯 `fetch`/`chrome.tabs`/Web-Crypto 实现，不再依赖 pi 的 `/oauth` 运行时。
 */
import type { OAuthAuth } from '@earendil-works/pi-ai';
import { providerCredentials, type OAuthCredential } from '@/lib/persistence/storage';
import { t } from '@/lib/i18n';
import { copilotOAuth, getGitHubCopilotBaseUrl, normalizeDomain } from './copilot';
import { codexOAuth } from './codex';
import { storedToPiCred, piToStoredCred, piCredToResult, type OAuthResult } from './credential';

export type { OAuthResult };
// 导出底层 OAuthAuth，便于将来直接喂给 pi 的 `createProvider({ auth: { oauth } })` 复用。
export { copilotOAuth, codexOAuth };

/** provider id → 对应的 vendored OAuthAuth。 */
const OAUTH_BY_PROVIDER: Record<string, OAuthAuth> = {
  'github-copilot': copilotOAuth,
  'openai-codex': codexOAuth,
};

const OAUTH_REFRESH_TIMEOUT_MS = 15_000;

function boundedRefreshSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(OAUTH_REFRESH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

// ─── GitHub Copilot 登录（设备码） ───

export interface GitHubCopilotCallbacks {
  onDeviceCode: (code: string, verificationUrl: string) => void;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export async function loginGitHubCopilot(callbacks: GitHubCopilotCallbacks): Promise<OAuthResult> {
  const cred = await copilotOAuth.login({
    signal: callbacks.signal ?? new AbortController().signal,
    // Cebian 不暴露企业域名输入 → 固定空串走 github.com。
    prompt: async () => '',
    notify: (event) => {
      if (event.type === 'device_code') {
        chrome.tabs.create({ url: event.verificationUri });
        callbacks.onDeviceCode(event.userCode, event.verificationUri);
      } else if (event.type === 'progress') {
        callbacks.onProgress?.(event.message);
      }
    },
  });
  return piCredToResult(cred);
}

// ─── OpenAI Codex 登录（Authorization Code + PKCE） ───

export async function loginOpenAICodex(signal?: AbortSignal): Promise<OAuthResult> {
  const cred = await codexOAuth.login({
    signal: signal ?? new AbortController().signal,
    prompt: async () => '',
    notify: () => {},
  });
  return piCredToResult(cred);
}

// ─── 统一刷新 ───

export async function refreshOAuthCredential(
  provider: string,
  cred: OAuthCredential,
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const oauth = OAUTH_BY_PROVIDER[provider];
  if (!oauth) throw new Error(t('errors.oauth.unknownProvider', [provider]));
  if (!cred.refreshToken) throw new Error(t('errors.oauth.missingRefreshTokenLocal'));
  const refreshed = piToStoredCred(
    await oauth.refresh(storedToPiCred(cred), boundedRefreshSignal(signal)),
  );
  // 保留刷新前 extra 里的其它字段（刷新结果里的同名字段优先）。
  const extra = { ...cred.extra, ...refreshed.extra };
  return { ...refreshed, extra: Object.keys(extra).length > 0 ? extra : undefined };
}

// ─── Copilot base URL（同步，供 resolve-model 注入 model.baseUrl） ───

export function getCopilotBaseUrl(cred: OAuthCredential): string {
  // extra 是 Record<string, unknown>，enterpriseUrl 只在确为字符串时才归一化——
  // 防一条非法凭据把同步的 baseUrl 推导（继而 resolveModel / 渲染）拖崩
  const enterpriseUrl = cred.extra?.enterpriseUrl;
  const domain = typeof enterpriseUrl === 'string'
    ? (normalizeDomain(enterpriseUrl) ?? undefined)
    : undefined;
  return getGitHubCopilotBaseUrl(cred.accessToken, domain);
}

// ─── 按需刷新（临近过期时刷新，并对并发去重） ───

// 过期前 5 分钟触发按需刷新
const ON_DEMAND_BUFFER_MS = 5 * 60 * 1000;

/** 每个 provider 的在途刷新 promise，用于去重并发刷新。 */
const inflightRefresh = new Map<string, Promise<OAuthCredential>>();

/**
 * 取一个有效的 OAuth token，临近过期则按需刷新；并发调用会复用同一次刷新。
 */
export async function getValidOAuthToken(
  provider: string,
  _cred: OAuthCredential,
): Promise<string> {
  // 重新读存储：后台 alarm 可能已经刷新过。
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

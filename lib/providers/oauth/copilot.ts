/*!
 * @license
 * Portions of this file are derived from @earendil-works/pi-ai
 * (src/utils/oauth/github-copilot.ts and src/utils/oauth/device-code.ts).
 *
 * MIT License
 *
 * Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/**
 * GitHub Copilot OAuth —— 设备码流（Device Code Flow），纯 `fetch`，浏览器安全。
 *
 * 自维护自 pi-ai `dist/utils/oauth/github-copilot.js`（MIT, Mario Zechner）：pi 0.80.8
 * 起把这些运行时函数从 `@earendil-works/pi-ai/oauth` 移除、改成 Node-only 的
 * bundler-opaque 懒加载，浏览器扩展无法再引用，故 vendored 进来。实现 pi 的 `OAuthAuth`
 * 接口，便于将来直接接入 pi 的 `createModels()` / `createProvider()`。
 *
 * client ID 用明文字面量（`Iv1.b507a08c87ecfe98` 是 GitHub Copilot Chat 的公开 OAuth
 * client id，VS Code / gh CLI 同款，抓包即见），不走 `atob`，从源头规避 Chrome Web Store
 * 的混淆代码判定。
 */
import type { OAuthAuth, OAuthCredential } from '@earendil-works/pi-ai';
import { GITHUB_COPILOT_MODELS } from '@earendil-works/pi-ai/providers/github-copilot.models';
import { t } from '@/lib/i18n';

const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
} as const;

// ─── 域名 / baseUrl 推导（纯函数，可单测） ───

/** 把用户输入（裸域名或完整 URL）归一化成 hostname；非法输入返回 null。 */
export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = trimmed.includes('://') ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname;
  } catch {
    return null;
  }
}

function baseUrlFromToken(token: string): string | null {
  // token 形如 `tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...`
  const match = token.match(/proxy-ep=([^;]+)/);
  if (!match) return null;
  return `https://${match[1].replace(/^proxy\./, 'api.')}`;
}

/**
 * 从 Copilot token 的 `proxy-ep` 推导 API baseUrl（同步）。token 解析不出时回退到
 * 企业域名或个人版默认端点。
 */
export function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string {
  if (token) {
    const fromToken = baseUrlFromToken(token);
    if (fromToken) return fromToken;
  }
  if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
  return 'https://api.individual.githubcopilot.com';
}

// ─── HTTP / 设备码轮询 ───

function endpoints(domain: string) {
  return {
    deviceCode: `https://${domain}/login/device/code`,
    accessToken: `https://${domain}/login/oauth/access_token`,
    copilotToken: `https://api.${domain}/copilot_internal/v2/token`,
  };
}

async function fetchJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, signal });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(t('errors.oauth.cancelled')));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(t('errors.oauth.cancelled')));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

async function startDeviceFlow(domain: string, signal: AbortSignal): Promise<DeviceCode> {
  const data = await fetchJson(endpoints(domain).deviceCode, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': COPILOT_HEADERS['User-Agent'],
    },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'read:user' }),
  }, signal);
  const deviceCode = data.device_code;
  const userCode = data.user_code;
  const verificationUri = data.verification_uri;
  const interval = data.interval;
  const expiresIn = data.expires_in;
  if (
    typeof deviceCode !== 'string' ||
    typeof userCode !== 'string' ||
    typeof verificationUri !== 'string' ||
    typeof expiresIn !== 'number'
  ) {
    throw new Error('Invalid device code response');
  }
  // 强制校验 verification_uri 是 http(s)，避免拿到危险协议。
  let parsed: URL;
  try {
    parsed = new URL(verificationUri);
  } catch {
    throw new Error('Untrusted verification_uri in device code response');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Untrusted verification_uri in device code response');
  }
  return {
    deviceCode,
    userCode,
    verificationUri: parsed.href,
    intervalSeconds: typeof interval === 'number' ? interval : 5,
    expiresInSeconds: expiresIn,
  };
}

/** 轮询 device_code 换取 GitHub access token；处理 authorization_pending / slow_down / 过期 / 中止。 */
async function pollForGitHubAccessToken(
  domain: string,
  device: DeviceCode,
  signal: AbortSignal,
): Promise<string> {
  const url = endpoints(domain).accessToken;
  const deadline = Date.now() + device.expiresInSeconds * 1000;
  let intervalMs = Math.max(1000, Math.floor(device.intervalSeconds * 1000));
  // RFC 8628 §3.5：首轮轮询前先等一个 interval。
  await abortableSleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);

  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error(t('errors.oauth.cancelled'));
    const raw = await fetchJson(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': COPILOT_HEADERS['User-Agent'],
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: device.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    }, signal);
    if (typeof raw.access_token === 'string') return raw.access_token;
    const error = raw.error;
    if (error === 'authorization_pending') {
      // 继续轮询
    } else if (error === 'slow_down') {
      // 优先采用服务端回报的新最小 interval（GitHub 在 slow_down 时会给），否则按 RFC 8628 加 5 秒。
      const serverInterval = raw.interval;
      intervalMs =
        typeof serverInterval === 'number' && Number.isFinite(serverInterval) && serverInterval > 0
          ? Math.max(1000, Math.floor(serverInterval * 1000))
          : intervalMs + 5000;
    } else if (typeof error === 'string') {
      const description = typeof raw.error_description === 'string' ? `: ${raw.error_description}` : '';
      throw new Error(`Device flow failed: ${error}${description}`);
    } else {
      throw new Error('Invalid device token response');
    }
    await abortableSleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
  }
  throw new Error(t('errors.oauth.timeout'));
}

interface CopilotTokenSet {
  access: string;
  refresh: string;
  expires: number;
  enterpriseUrl?: string;
}

/** 用 GitHub refresh token 换取 Copilot API token（并算好带 5min 缓冲的过期时刻）。 */
async function refreshCopilotToken(
  refreshToken: string,
  enterpriseDomain: string | undefined,
  signal: AbortSignal,
): Promise<CopilotTokenSet> {
  const domain = enterpriseDomain || 'github.com';
  const raw = await fetchJson(endpoints(domain).copilotToken, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${refreshToken}`,
      ...COPILOT_HEADERS,
    },
  }, signal);
  const token = raw.token;
  const expiresAt = raw.expires_at;
  if (typeof token !== 'string' || typeof expiresAt !== 'number') {
    throw new Error('Invalid Copilot token response');
  }
  return {
    refresh: refreshToken,
    access: token,
    expires: expiresAt * 1000 - 5 * 60 * 1000,
    enterpriseUrl: enterpriseDomain,
  };
}

/**
 * 登录成功后逐个把内置 Copilot 模型 POST 到 `/policy` 开启（Claude / Grok 等需要显式
 * 开启才能用）。模型 id 列表取自 pi 的静态目录 `GITHUB_COPILOT_MODELS`（与 upstream 一致）。
 * best-effort：任一模型开启失败都不阻断登录。
 */
async function enableAllCopilotModels(
  token: string,
  enterpriseDomain: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  const ids = Object.values(GITHUB_COPILOT_MODELS).map((model) => model.id);
  const baseUrl = getGitHubCopilotBaseUrl(token, enterpriseDomain);
  await Promise.all(
    ids.map(async (id) => {
      try {
        await fetch(`${baseUrl}/models/${id}/policy`, {
          method: 'POST',
          signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...COPILOT_HEADERS,
            'openai-intent': 'chat-policy',
            'x-interaction-type': 'chat-policy',
          },
          body: JSON.stringify({ state: 'enabled' }),
        });
      } catch (err) {
        if (signal.aborted) throw err;
        // best-effort，忽略
      }
    }),
  );
}

function enterpriseDomainOf(credential: OAuthCredential): string | undefined {
  const enterpriseUrl = credential.enterpriseUrl;
  if (typeof enterpriseUrl !== 'string' || !enterpriseUrl) return undefined;
  return normalizeDomain(enterpriseUrl) ?? undefined;
}

// ─── provider-owned OAuthAuth（pi 接口） ───

export const copilotOAuth: OAuthAuth = {
  name: 'GitHub Copilot',

  async login(interaction) {
    // 企业域名输入框：Cebian 侧适配层固定返回空串 → 走 github.com（保持现有行为）。
    const input = await interaction.prompt({
      type: 'text',
      message: 'GitHub Enterprise URL/domain (blank for github.com)',
      placeholder: 'company.ghe.com',
    });
    if (interaction.signal?.aborted) throw new Error(t('errors.oauth.cancelled'));
    const trimmed = input.trim();
    const enterpriseDomain = trimmed ? normalizeDomain(input) : null;
    if (trimmed && !enterpriseDomain) throw new Error('Invalid GitHub Enterprise URL/domain');
    const domain = enterpriseDomain ?? 'github.com';

    const device = await startDeviceFlow(domain, interaction.signal);
    interaction.notify({
      type: 'device_code',
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      intervalSeconds: device.intervalSeconds,
      expiresInSeconds: device.expiresInSeconds,
    });

    const githubToken = await pollForGitHubAccessToken(domain, device, interaction.signal);
    const tokens = await refreshCopilotToken(
      githubToken,
      enterpriseDomain ?? undefined,
      interaction.signal,
    );
    interaction.notify({ type: 'progress', message: 'Enabling models...' });
    await enableAllCopilotModels(tokens.access, enterpriseDomain ?? undefined, interaction.signal);
    return { type: 'oauth', ...tokens };
  },

  async refresh(credential, signal) {
    const tokens = await refreshCopilotToken(
      credential.refresh,
      enterpriseDomainOf(credential),
      signal,
    );
    return { type: 'oauth', ...tokens };
  },

  async toAuth(credential) {
    return {
      apiKey: credential.access,
      baseUrl: getGitHubCopilotBaseUrl(credential.access, enterpriseDomainOf(credential)),
    };
  },
};

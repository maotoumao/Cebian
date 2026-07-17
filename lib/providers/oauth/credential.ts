/**
 * 凭证形状适配：pi 的 `OAuthCredential`（`access` / `refresh` / `expires`）↔ 本项目落库的
 * `OAuthCredential`（`accessToken` / `refreshToken` / `expiresAt`，见 persistence/storage）。
 *
 * 落库字段名是外部契约（`chrome.storage.local` 里已有用户数据），不能改；pi 的形状是库契约。
 * 这层是两者之间唯一的转换边界，保持纯函数以便单测（token 搬运出错=静默数据损坏，属高危逻辑）。
 * pi 的类型以 `Pi*` 别名引入，避开与本项目同名 `OAuthCredential` 的撞名。
 */
import type { OAuthCredential as PiOAuthCredential } from '@earendil-works/pi-ai';
import type { OAuthCredential } from '@/lib/persistence/storage';

/** 登录流程对外返回的结果（保持与旧 `lib/providers/oauth.ts` 一致的公共形状）。 */
export interface OAuthResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  extra?: Record<string, unknown>;
}

/** pi 凭证里属于「核心令牌字段」的 key，其余一律视为可搬运的 provider 元数据（如 enterpriseUrl）。 */
const RESERVED_PI_KEYS = new Set(['type', 'access', 'refresh', 'expires']);

/** 把 pi 凭证里的非核心字段收集成 `extra`（空则返回 undefined）。 */
function extraFromPiCred(pi: PiOAuthCredential): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(pi)) {
    if (!RESERVED_PI_KEYS.has(key) && value !== undefined) extra[key] = value;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/** 落库凭证 → pi 凭证。`extra` 里的全部字段（如 enterpriseUrl）平铺到 pi 凭证顶层，供 refresh/toAuth 读取。 */
export function storedToPiCred(cred: OAuthCredential): PiOAuthCredential {
  return {
    ...(cred.extra ?? {}),
    type: 'oauth',
    access: cred.accessToken,
    refresh: cred.refreshToken ?? '',
    expires: cred.expiresAt ?? 0,
  };
}

/** pi 凭证 → 落库凭证（刷新成功即视为 verified；非核心字段回收进 extra）。 */
export function piToStoredCred(pi: PiOAuthCredential): OAuthCredential {
  return {
    authType: 'oauth',
    accessToken: pi.access,
    refreshToken: pi.refresh,
    expiresAt: pi.expires,
    verified: true,
    extra: extraFromPiCred(pi),
  };
}

/** pi 凭证 → 登录结果（非核心字段回收进 extra）。 */
export function piCredToResult(pi: PiOAuthCredential): OAuthResult {
  return {
    accessToken: pi.access,
    refreshToken: pi.refresh,
    expiresAt: pi.expires,
    extra: extraFromPiCred(pi),
  };
}

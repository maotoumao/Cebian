// Provider 凭证的按需解析（「拉」的一侧；「推」的一侧是同目录的 oauth-refresh.ts
// 周期预刷新）。

import { providerCredentials, type OAuthCredential } from '@/lib/persistence/storage';
import { getValidOAuthToken } from '@/lib/providers/oauth';

/**
 * 解析某个 provider 的有效 API key：`apiKey` 凭证直接返回；`oauth` 凭证走
 * `getValidOAuthToken`（含自动刷新）。
 *
 * 背景侧所有要发模型请求的地方共用它，避免多处复制凭证解析逻辑：agent 的
 * `getApiKey`、压缩流程的独立 `generateSummary` 调用、划词动作的流式调用。
 */
export async function resolveProviderApiKey(
  provider: string,
): Promise<string | undefined> {
  try {
    const creds = await providerCredentials.getValue();
    const cred = creds[provider];
    if (!cred) return undefined;

    if (cred.authType === 'apiKey') {
      return cred.apiKey;
    }

    if (cred.authType === 'oauth') {
      return getValidOAuthToken(provider, cred as OAuthCredential);
    }
  } catch (err) {
    console.error(`[credentials] Failed to get API key for ${provider}:`, err);
  }
  return undefined;
}

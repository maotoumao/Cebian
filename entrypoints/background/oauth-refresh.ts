import { providerCredentials, type OAuthCredential, type ProviderCredentials } from '@/lib/storage';
import { refreshOAuthCredential } from '@/lib/oauth';

const ALARM_NAME = 'oauth-refresh';
const REFRESH_INTERVAL_MINUTES = 30;
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export function setupOAuthRefresh() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: REFRESH_INTERVAL_MINUTES });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM_NAME) return;

    const creds = await providerCredentials.getValue();
    let updated = false;
    const next: ProviderCredentials = { ...creds };

    for (const [provider, cred] of Object.entries(creds)) {
      if (cred.authType !== 'oauth' || !cred.refreshToken || !cred.expiresAt) continue;
      if (Date.now() < cred.expiresAt - EXPIRY_BUFFER_MS) continue;

      try {
        const refreshed = await refreshOAuthCredential(provider, cred as OAuthCredential);
        next[provider] = refreshed;
        updated = true;
        console.log(`[OAuth Refresh] ${provider}: token refreshed`);
      } catch (err) {
        console.error(`[OAuth Refresh] ${provider}:`, err);
        next[provider] = { ...(cred as OAuthCredential), verified: false };
        updated = true;
      }
    }

    if (updated) {
      await providerCredentials.setValue(next);
    }
  });
}

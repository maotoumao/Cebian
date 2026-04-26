import { getModels, type KnownProvider, type Api, type Model } from '@mariozechner/pi-ai';
import type { ProviderCredential, CustomProviderConfig } from '@/lib/storage';
import { isCustomProvider, findCustomProvider, getCustomModels } from '@/lib/custom-models';
import { t } from '@/lib/i18n';

interface ProviderSummaryProps {
  provider: string;
  credential: ProviderCredential;
  customProviders: CustomProviderConfig[];
}

export function ProviderSummary({ provider, credential, customProviders }: ProviderSummaryProps) {
  let models: Model<Api>[] = [];
  let displayName = provider;

  if (isCustomProvider(provider)) {
    const config = findCustomProvider(customProviders, provider);
    if (config) {
      models = getCustomModels(config);
      displayName = config.name;
    }
  } else {
    try {
      models = getModels(provider as KnownProvider) as Model<Api>[];
    } catch {
      // unknown provider
    }
  }

  const modelCount = models.length;
  const authLabel = credential.authType === 'oauth' ? 'OAuth' : 'API Key';
  const verified = credential.verified;
  const statusText = verified
    ? credential.authType === 'oauth'
      ? t('provider.oauth.loggedIn')
      : t('provider.status.connected')
    : t('provider.status.unverified');

  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block size-2 rounded-full ${verified ? 'bg-emerald-500' : 'bg-muted-foreground'}`}
          />
          <span className="text-sm font-medium">{displayName}</span>
          <span
            className={`text-xs ${verified ? 'text-emerald-500' : 'text-muted-foreground'}`}
          >
            {verified ? '✓ ' : ''}{statusText}
          </span>
        </div>
        <div className="text-xs text-muted-foreground pl-4">
          {t('provider.summary.modelsAvailable', [authLabel, modelCount])}
        </div>
      </div>
    </div>
  );
}

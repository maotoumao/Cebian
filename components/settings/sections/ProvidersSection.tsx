import { Fragment, useState, useRef, useMemo } from 'react';
import { ChevronDown } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { ProviderOAuthItem, type OAuthPhase } from '@/components/settings/provider/ProviderOAuthItem';
import { ProviderApiKeyItem } from '@/components/settings/provider/ProviderApiKeyItem';
import { CustomProviderForm, CustomProviderCard } from '@/components/settings/provider/CustomProviderForm';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  providerCredentials,
  activeModel,
  customProviders,
  type ApiKeyCredential,
  type OAuthCredential,
  type ProviderCredentials,
  type CustomProviderConfig,
} from '@/lib/storage';
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from '@/lib/constants';
import { customProviderKey } from '@/lib/custom-models';
import { loginGitHubCopilot, loginOpenAICodex } from '@/lib/oauth';
import { t } from '@/lib/i18n';

/**
 * ProvidersSection — Settings hub section for managing AI providers.
 *
 * Migrated from ProviderManagerDialog (stage 2a). Same state + handlers;
 * Dialog wrapper dropped since the Settings hub is already a page.
 */
export function ProvidersSection() {
  const [providers, setProviders] = useStorageItem(providerCredentials, {});
  const [currentModel, setCurrentModel] = useStorageItem(activeModel, null);
  const [customs, setCustoms] = useStorageItem(customProviders, []);
  const [oauthStates, setOAuthStates] = useState<Record<string, OAuthPhase>>({});
  const [apiKeysExpanded, setApiKeysExpanded] = useState(false);
  const abortRefs = useRef<Record<string, AbortController>>({});

  // API Key provider 太多，默认只展示「常驻」（pinned）与「已配置」（有凭据）的，
  // 其余收进展开开关。两组各自保持 APIKEY_PROVIDERS 的原始（字母）顺序。
  const { visibleApiKeyProviders, hiddenApiKeyProviders } = useMemo(() => {
    const visible: (typeof APIKEY_PROVIDERS)[number][] = [];
    const hidden: (typeof APIKEY_PROVIDERS)[number][] = [];
    for (const p of APIKEY_PROVIDERS) {
      const pinned = 'pinned' in p && p.pinned;
      const configured = !!providers[p.provider];
      if (pinned || configured) visible.push(p);
      else hidden.push(p);
    }
    return { visibleApiKeyProviders: visible, hiddenApiKeyProviders: hidden };
  }, [providers]);

  const getOAuthState = (provider: string): OAuthPhase =>
    oauthStates[provider] ?? { phase: 'idle' };

  const setOAuthState = (provider: string, state: OAuthPhase) =>
    setOAuthStates((prev) => ({ ...prev, [provider]: state }));

  const clearActiveModelIfNeeded = (provider: string) => {
    if (currentModel?.provider === provider) {
      setCurrentModel(null);
    }
  };

  const handleCredentialSave = (provider: string, credential: ApiKeyCredential | OAuthCredential) => {
    setProviders({ ...providers, [provider]: credential });
  };

  const handleApiKeyRemove = (provider: string) => {
    const next: ProviderCredentials = { ...providers };
    delete next[provider];
    setProviders(next);
    clearActiveModelIfNeeded(provider);
  };

  const handleOAuthLogin = async (provider: string) => {
    // Guard against concurrent logins
    if (abortRefs.current[provider]) return;

    const abort = new AbortController();
    abortRefs.current[provider] = abort;
    setOAuthState(provider, { phase: 'authorizing' });

    try {
      let result;

      switch (provider) {
        case 'github-copilot':
          result = await loginGitHubCopilot({
            onDeviceCode: (code) => {
              setOAuthState(provider, { phase: 'authorizing', deviceCode: code });
            },
            signal: abort.signal,
          });
          break;
        case 'openai-codex':
          result = await loginOpenAICodex(abort.signal);
          break;
        default:
          return;
      }

      handleCredentialSave(provider, {
        authType: 'oauth',
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: result.expiresAt,
        verified: true,
        extra: result.extra,
      });
      setOAuthState(provider, { phase: 'success' });
      setTimeout(() => setOAuthState(provider, { phase: 'idle' }), 3000);
    } catch (err) {
      if (abort.signal.aborted) return;
      setOAuthState(provider, {
        phase: 'error',
        message: err instanceof Error ? err.message : t('provider.oauth.authFailed'),
      });
    } finally {
      delete abortRefs.current[provider];
    }
  };

  const handleOAuthCancel = (provider: string) => {
    abortRefs.current[provider]?.abort();
    delete abortRefs.current[provider];
    setOAuthState(provider, { phase: 'idle' });
  };

  const handleOAuthLogout = (provider: string) => {
    const next: ProviderCredentials = { ...providers };
    delete next[provider];
    setProviders(next);
    clearActiveModelIfNeeded(provider);
    setOAuthState(provider, { phase: 'idle' });
  };

  const handleAddCustomProvider = (config: CustomProviderConfig, apiKey?: string) => {
    if (customs.some((c) => c.id === config.id)) return;
    setCustoms([...customs, config]);
    if (apiKey) {
      const key = customProviderKey(config.id);
      handleCredentialSave(key, { authType: 'apiKey', apiKey, verified: true });
    }
  };

  const handleUpdateCustomProvider = (config: CustomProviderConfig, apiKey?: string) => {
    setCustoms(customs.map((c) => (c.id === config.id ? config : c)));
    const key = customProviderKey(config.id);
    if (apiKey) {
      handleCredentialSave(key, { authType: 'apiKey', apiKey, verified: true });
    } else {
      handleApiKeyRemove(key);
    }
  };

  const handleRemoveCustomProvider = (id: string) => {
    setCustoms(customs.filter((c) => c.id !== id));
    const key = customProviderKey(id);
    const next: ProviderCredentials = { ...providers };
    delete next[key];
    setProviders(next);
    clearActiveModelIfNeeded(key);
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.providers.title')}</h2>

      {/* OAuth providers */}
      <div className="space-y-4">
        <h3 className="text-xs text-muted-foreground font-medium tracking-wide uppercase">OAuth</h3>
        {OAUTH_PROVIDERS.map((p, i) => (
          <Fragment key={p.provider}>
            {i > 0 && <Separator />}
            <ProviderOAuthItem
              provider={p.provider}
              label={p.label}
              description={p.getDescription()}
              flow={p.flow}
              credential={providers[p.provider] as OAuthCredential | undefined}
              oauthState={getOAuthState(p.provider)}
              onLogin={() => handleOAuthLogin(p.provider)}
              onLogout={() => handleOAuthLogout(p.provider)}
              onCancel={() => handleOAuthCancel(p.provider)}
            />
          </Fragment>
        ))}
      </div>

      {/* API Key providers */}
      <div className="space-y-4">
        <h3 className="text-xs text-muted-foreground font-medium tracking-wide uppercase">{t('provider.section.viaApiKey')}</h3>
        {visibleApiKeyProviders.map((p, i) => (
          <Fragment key={p.provider}>
            {i > 0 && <Separator />}
            <ProviderApiKeyItem
              provider={p.provider}
              label={p.label}
              credential={providers[p.provider] as ApiKeyCredential | undefined}
              onSave={(cred) => handleCredentialSave(p.provider, cred)}
              onRemove={() => handleApiKeyRemove(p.provider)}
            />
          </Fragment>
        ))}

        {hiddenApiKeyProviders.length > 0 && (
          <>
            {apiKeysExpanded &&
              hiddenApiKeyProviders.map((p) => (
                <Fragment key={p.provider}>
                  <Separator />
                  <ProviderApiKeyItem
                    provider={p.provider}
                    label={p.label}
                    credential={providers[p.provider] as ApiKeyCredential | undefined}
                    onSave={(cred) => handleCredentialSave(p.provider, cred)}
                    onRemove={() => handleApiKeyRemove(p.provider)}
                  />
                </Fragment>
              ))}
            <button
              type="button"
              onClick={() => setApiKeysExpanded((v) => !v)}
              aria-expanded={apiKeysExpanded}
              className="flex w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronDown
                className={`size-3.5 transition-transform ${apiKeysExpanded ? 'rotate-180' : ''}`}
              />
              {apiKeysExpanded
                ? t('provider.section.showLess')
                : t('provider.section.showMore', [hiddenApiKeyProviders.length])}
            </button>
          </>
        )}
      </div>

      {/* Custom OpenAI-compatible providers */}
      <div className="space-y-4">
        <h3 className="text-xs text-muted-foreground font-medium tracking-wide uppercase">OpenAI Compatible</h3>

        {customs.map((c) => {
          const key = customProviderKey(c.id);
          const cred = providers[key] as ApiKeyCredential | undefined;
          return (
            <CustomProviderCard
              key={key}
              config={c}
              apiKey={cred?.apiKey ?? ''}
              verified={!!cred?.verified}
              onUpdate={handleUpdateCustomProvider}
              onRemove={() => handleRemoveCustomProvider(c.id)}
            />
          );
        })}

        <CustomProviderForm onAdd={handleAddCustomProvider} />
      </div>
    </div>
  );
}

import { Fragment, useState, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS, PRESET_PROVIDERS } from '@/lib/constants';
import { customProviderKey, getCustomModels } from '@/lib/custom-models';
import { loginGitHubCopilot, loginOpenAICodex, loginGeminiCli } from '@/lib/oauth';

interface ProviderManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProviderManagerDialog({ open, onOpenChange }: ProviderManagerDialogProps) {
  const [providers, setProviders] = useStorageItem(providerCredentials, {});
  const [currentModel, setCurrentModel] = useStorageItem(activeModel, null);
  const [customs, setCustoms] = useStorageItem(customProviders, []);
  const [oauthStates, setOAuthStates] = useState<Record<string, OAuthPhase>>({});
  const abortRefs = useRef<Record<string, AbortController>>({});

  const getOAuthState = (provider: string): OAuthPhase =>
    oauthStates[provider] ?? { phase: 'idle' };

  const setOAuthState = (provider: string, state: OAuthPhase) =>
    setOAuthStates(prev => ({ ...prev, [provider]: state }));

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
        case 'google-gemini-cli':
          result = await loginGeminiCli(abort.signal);
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
        message: err instanceof Error ? err.message : '授权失败',
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
    if (customs.some(c => c.id === config.id) || PRESET_PROVIDERS.some(p => p.id === config.id)) return;
    setCustoms([...customs, config]);
    if (apiKey) {
      const key = customProviderKey(config.id);
      handleCredentialSave(key, { authType: 'apiKey', apiKey, verified: true });
    }
  };

  const handleUpdateCustomProvider = (config: CustomProviderConfig, apiKey?: string) => {
    setCustoms(customs.map(c => c.id === config.id ? config : c));
    const key = customProviderKey(config.id);
    if (apiKey) {
      handleCredentialSave(key, { authType: 'apiKey', apiKey, verified: true });
    } else {
      handleApiKeyRemove(key);
    }
  };

  const handleRemoveCustomProvider = (id: string) => {
    setCustoms(customs.filter(c => c.id !== id));
    const key = customProviderKey(id);
    const next: ProviderCredentials = { ...providers };
    delete next[key];
    setProviders(next);
    clearActiveModelIfNeeded(key);
  };

  // Filter out preset providers from user customs
  const userCustoms = customs.filter(
    c => !PRESET_PROVIDERS.some(p => p.id === c.id),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 p-6 pb-4">
          <DialogTitle>管理 AI 提供商</DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto min-h-0 px-6 pb-6 space-y-4">
          {/* OAuth providers */}
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">OAuth</p>
            {OAUTH_PROVIDERS.map((p, i) => (
              <Fragment key={p.provider}>
                {i > 0 && <Separator />}
                <ProviderOAuthItem
                  provider={p.provider}
                  label={p.label}
                  description={p.description}
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
          <div className="mt-4 space-y-4">
            <p className="text-xs text-muted-foreground">通过 API Key</p>
            {APIKEY_PROVIDERS.map((p, i) => {
              if ('preset' in p && p.preset) {
                const presetConfig = PRESET_PROVIDERS.find(pp => pp.id === p.provider);
                if (!presetConfig) return null;
                const key = customProviderKey(presetConfig.id);
                return (
                  <Fragment key={key}>
                    {i > 0 && <Separator />}
                    <ProviderApiKeyItem
                      provider={key}
                      label={presetConfig.name}
                      models={getCustomModels(presetConfig)}
                      credential={providers[key] as ApiKeyCredential | undefined}
                      onSave={(cred) => handleCredentialSave(key, cred)}
                      onRemove={() => handleApiKeyRemove(key)}
                    />
                  </Fragment>
                );
              }
              return (
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
              );
            })}
          </div>

          {/* Custom OpenAI-compatible providers */}
          <div className="mt-4 space-y-4">
            <p className="text-xs text-muted-foreground">OpenAI Compatible</p>

            {/* Existing user custom providers */}
            {userCustoms.map((c) => {
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
      </DialogContent>
    </Dialog>
  );
}

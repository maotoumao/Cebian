import { Fragment } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { ProviderOAuthItem } from '@/components/settings/provider/ProviderOAuthItem';
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

interface ProviderManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProviderManagerDialog({ open, onOpenChange }: ProviderManagerDialogProps) {
  const [providers, setProviders] = useStorageItem(providerCredentials, {});
  const [currentModel, setCurrentModel] = useStorageItem(activeModel, null);
  const [customs, setCustoms] = useStorageItem(customProviders, []);

  const clearActiveModelIfNeeded = (provider: string) => {
    if (currentModel?.provider === provider) {
      setCurrentModel(null);
    }
  };

  const handleApiKeySave = (provider: string, credential: ApiKeyCredential) => {
    setProviders({ ...providers, [provider]: credential });
  };

  const handleApiKeyRemove = (provider: string) => {
    const next: ProviderCredentials = { ...providers };
    delete next[provider];
    setProviders(next);
    clearActiveModelIfNeeded(provider);
  };

  const handleOAuthLogin = (provider: string) => {
    console.log(`[OAuth] Login requested for ${provider}`);
  };

  const handleOAuthLogout = (provider: string) => {
    const next: ProviderCredentials = { ...providers };
    delete next[provider];
    setProviders(next);
    clearActiveModelIfNeeded(provider);
  };

  const handleAddCustomProvider = (config: CustomProviderConfig) => {
    if (customs.some(c => c.id === config.id) || PRESET_PROVIDERS.some(p => p.id === config.id)) return;
    setCustoms([...customs, config]);
  };

  const handleRemoveCustomProvider = (id: string) => {
    setCustoms(customs.filter(c => c.id !== id));
    const key = customProviderKey(id);
    const next: ProviderCredentials = { ...providers };
    delete next[key];
    setProviders(next);
    clearActiveModelIfNeeded(key);
  };

  // Merge preset providers (not yet added as custom) into the preset list
  const presetConfigs = PRESET_PROVIDERS;
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
                  credential={providers[p.provider] as OAuthCredential | undefined}
                  onLogin={() => handleOAuthLogin(p.provider)}
                  onLogout={() => handleOAuthLogout(p.provider)}
                />
              </Fragment>
            ))}
          </div>

          {/* API Key providers */}
          <div className="mt-4 space-y-4">
            <p className="text-xs text-muted-foreground">通过 API Key</p>
            {APIKEY_PROVIDERS.map((p, i) => (
              <Fragment key={p.provider}>
                {i > 0 && <Separator />}
                <ProviderApiKeyItem
                  provider={p.provider}
                  label={p.label}
                  credential={providers[p.provider] as ApiKeyCredential | undefined}
                  onSave={(cred) => handleApiKeySave(p.provider, cred)}
                  onRemove={() => handleApiKeyRemove(p.provider)}
                />
              </Fragment>
            ))}

            {/* Preset custom providers (DeepSeek etc.) — same UI as built-in */}
            {presetConfigs.map((p) => {
              const key = customProviderKey(p.id);
              return (
                <Fragment key={key}>
                  <Separator />
                  <ProviderApiKeyItem
                    provider={key}
                    label={p.name}
                    models={getCustomModels(p)}
                    credential={providers[key] as ApiKeyCredential | undefined}
                    onSave={(cred) => handleApiKeySave(key, cred)}
                    onRemove={() => handleApiKeyRemove(key)}
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
                <Fragment key={key}>
                  <CustomProviderCard
                    config={c}
                    verified={!!cred?.verified}
                    onRemove={() => handleRemoveCustomProvider(c.id)}
                  />
                  <ProviderApiKeyItem
                    provider={key}
                    label={c.name}
                    models={getCustomModels(c)}
                    credential={cred}
                    onSave={(cr) => handleApiKeySave(key, cr)}
                    onRemove={() => handleApiKeyRemove(key)}
                  />
                </Fragment>
              );
            })}

            <CustomProviderForm onAdd={handleAddCustomProvider} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

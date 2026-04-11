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
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  providerCredentials,
  type ApiKeyCredential,
  type OAuthCredential,
  type ProviderCredentials,
} from '@/lib/storage';
import { OAUTH_PROVIDERS, APIKEY_PROVIDERS } from '@/lib/constants';

interface ProviderManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProviderManagerDialog({ open, onOpenChange }: ProviderManagerDialogProps) {
  const [providers, setProviders] = useStorageItem(providerCredentials, {});

  const handleApiKeySave = (provider: string, credential: ApiKeyCredential) => {
    setProviders({ ...providers, [provider]: credential });
  };

  const handleOAuthLogin = (provider: string) => {
    console.log(`[OAuth] Login requested for ${provider}`);
  };

  const handleOAuthLogout = (provider: string) => {
    const next: ProviderCredentials = { ...providers };
    delete next[provider];
    setProviders(next);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>管理 AI 提供商</DialogTitle>
        </DialogHeader>

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
              />
            </Fragment>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { LogIn, LogOut, X, Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { copyText } from '@/lib/clipboard';
import { t } from '@/lib/i18n';
import type { OAuthCredential } from '@/lib/storage';

export type OAuthPhase =
  | { phase: 'idle' }
  | { phase: 'authorizing'; deviceCode?: string; message?: string }
  | { phase: 'success' }
  | { phase: 'error'; message: string };

interface ProviderOAuthItemProps {
  provider: string;
  label: string;
  description: string;
  flow: 'device-code' | 'auth-code';
  credential?: OAuthCredential;
  oauthState: OAuthPhase;
  onLogin: () => void;
  onLogout: () => void;
  onCancel: () => void;
}

export function ProviderOAuthItem({
  provider,
  label,
  description,
  flow,
  credential,
  oauthState,
  onLogin,
  onLogout,
  onCancel,
}: ProviderOAuthItemProps) {
  const isLoggedIn = credential?.verified;
  const isAuthorizing = oauthState.phase === 'authorizing';
  const [copied, setCopied] = useState(false);

  const handleCopyCode = (code: string) => {
    void copyText(code, { silent: true });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const statusBadge = () => {
    if (isAuthorizing) {
      return <Badge variant="outline" className="text-blue-500 border-blue-500/20 bg-blue-500/5 text-[0.65rem] h-4 px-1.5">{t('provider.oauth.authorizing')}</Badge>;
    }
    if (oauthState.phase === 'error') {
      return <Badge variant="outline" className="text-destructive border-destructive/20 bg-destructive/5 text-[0.65rem] h-4 px-1.5">{t('provider.status.failed')}</Badge>;
    }
    if (isLoggedIn) {
      return <Badge variant="outline" className="text-success border-success/20 bg-success/5 text-[0.65rem] h-4 px-1.5">{t('provider.oauth.loggedIn')}</Badge>;
    }
    return <Badge variant="outline" className="text-muted-foreground border-border text-[0.65rem] h-4 px-1.5">{t('provider.oauth.notLoggedIn')}</Badge>;
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{label}</p>
            {statusBadge()}
          </div>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>

        <div className="flex items-center gap-1 shrink-0 ml-2">
          {isAuthorizing ? (
            <Button variant="ghost" size="sm" onClick={onCancel}>
              <X className="size-3.5" />
              {t('common.cancel')}
            </Button>
          ) : isLoggedIn ? (
            <Button variant="outline" size="sm" onClick={onLogout}>
              <LogOut className="size-3.5" />
              {t('provider.oauth.signOut')}
            </Button>
          ) : (
            <Button size="sm" onClick={onLogin} disabled={isAuthorizing}>
              <LogIn className="size-3.5" />
              {t('provider.oauth.signIn')}
            </Button>
          )}
        </div>
      </div>

      {/* Device code display (GitHub Copilot) */}
      {isAuthorizing && oauthState.deviceCode && (
        <div className="flex items-center gap-2 rounded-md bg-accent/50 border border-border px-3 py-2">
          <Spinner className="size-3.5 shrink-0" />
          <p className="text-xs text-muted-foreground flex-1">
            {t('provider.oauth.enterCode')}
          </p>
          <code className="text-sm font-mono font-bold tracking-wider">{oauthState.deviceCode}</code>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => handleCopyCode(oauthState.deviceCode!)}
            title={t('common.copy')}
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </Button>
        </div>
      )}

      {/* Auth-code flow: waiting message */}
      {isAuthorizing && flow === 'auth-code' && !oauthState.deviceCode && (
        <div className="flex items-center gap-2 rounded-md bg-accent/50 border border-border px-3 py-2">
          <Spinner className="size-3.5 shrink-0" />
          <p className="text-xs text-muted-foreground">
            {t('provider.oauth.completeInBrowser')}
          </p>
        </div>
      )}

      {/* Error message */}
      {oauthState.phase === 'error' && (
        <p className="text-xs text-destructive">{oauthState.message}</p>
      )}
    </div>
  );
}

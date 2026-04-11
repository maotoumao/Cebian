import { Check, LogIn, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { OAuthCredential } from '@/lib/storage';

interface ProviderOAuthItemProps {
  provider: string;
  label: string;
  description: string;
  credential?: OAuthCredential;
  onLogin: () => void;
  onLogout: () => void;
}

export function ProviderOAuthItem({
  provider,
  label,
  description,
  credential,
  onLogin,
  onLogout,
}: ProviderOAuthItemProps) {
  const isLoggedIn = credential?.verified;

  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>

      <div className="flex items-center justify-between">
        {isLoggedIn ? (
          <>
            <p className="flex items-center gap-1 text-xs text-success">
              <Check className="size-3" />
              已登录
            </p>
            <Button variant="outline" size="sm" onClick={onLogout}>
              <LogOut className="size-3.5" />
              退出登录
            </Button>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">未登录</p>
            <Button size="sm" onClick={onLogin}>
              <LogIn className="size-3.5" />
              使用账号登录
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

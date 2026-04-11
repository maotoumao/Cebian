import { LogIn, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{label}</p>
            {isLoggedIn ? (
              <Badge role="status" variant="outline" className="text-success border-success/20 bg-success/5 text-[0.65rem] h-4 px-1.5">已登录</Badge>
            ) : (
              <Badge role="status" variant="outline" className="text-muted-foreground border-border text-[0.65rem] h-4 px-1.5">未登录</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        {isLoggedIn ? (
          <Button variant="outline" size="sm" onClick={onLogout}>
            <LogOut className="size-3.5" />
            退出
          </Button>
        ) : (
          <Button size="sm" onClick={onLogin}>
            <LogIn className="size-3.5" />
            登录
          </Button>
        )}
      </div>
    </div>
  );
}

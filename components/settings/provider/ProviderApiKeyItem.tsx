import { useState, useMemo } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { getModels, complete, type KnownProvider } from '@mariozechner/pi-ai';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Badge } from '@/components/ui/badge';
import type { ApiKeyCredential } from '@/lib/storage';

interface ProviderApiKeyItemProps {
  provider: string;
  label: string;
  credential?: ApiKeyCredential;
  onSave: (credential: ApiKeyCredential) => void;
}

export function ProviderApiKeyItem({
  provider,
  label,
  credential,
  onSave,
}: ProviderApiKeyItemProps) {
  const [key, setKey] = useState(credential?.apiKey ?? '');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<
    { type: 'success'; message: string } | { type: 'error'; message: string } | null
  >(null);

  const { firstModel, modelCount } = useMemo(() => {
    try {
      const models = getModels(provider as KnownProvider);
      return { firstModel: models[0], modelCount: models.length };
    } catch {
      return { firstModel: undefined, modelCount: 0 };
    }
  }, [provider]);

  const handleSave = async () => {
    if (!firstModel || !key.trim()) return;

    setSaving(true);
    setStatus(null);

    try {
      await complete(firstModel, {
        messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
      }, { apiKey: key });

      onSave({ authType: 'apiKey', apiKey: key, verified: true });
      setStatus({ type: 'success', message: `已连接 · ${modelCount} 个模型` });
    } catch (err) {
      console.error(`[ApiKey Verify] ${provider}:`, err);
      setStatus({ type: 'error', message: '连接失败' });
    } finally {
      setSaving(false);
    }
  };

  const statusBadge = () => {
    if (status?.type === 'error') {
      return <Badge role="status" variant="outline" className="text-destructive border-destructive/20 bg-destructive/5 text-[0.65rem] h-4 px-1.5">连接失败</Badge>;
    }
    if (status?.type === 'success' || credential?.verified) {
      return <Badge role="status" variant="outline" className="text-success border-success/20 bg-success/5 text-[0.65rem] h-4 px-1.5">已连接</Badge>;
    }
    if (credential && !credential.verified) {
      return <Badge role="status" variant="outline" className="text-yellow-500 border-yellow-500/20 bg-yellow-500/5 text-[0.65rem] h-4 px-1.5">未验证</Badge>;
    }
    return <Badge role="status" variant="outline" className="text-muted-foreground border-border text-[0.65rem] h-4 px-1.5">未配置</Badge>;
  };

  if (!firstModel) {
    return (
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">{label}</p>
        <Badge variant="outline" className="text-muted-foreground border-border text-[0.65rem] h-4 px-1.5">无可用模型</Badge>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">{label}</p>
        {statusBadge()}
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            type={showKey ? 'text' : 'password'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="输入 API Key"
            className="pr-8"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="absolute right-1 top-1/2 -translate-y-1/2"
            onClick={() => setShowKey(!showKey)}
            tabIndex={-1}
          >
            {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </Button>
        </div>

        <Button
          size="sm"
          disabled={saving || !key.trim()}
          onClick={handleSave}
        >
          {saving ? (
            <>
              <Spinner className="size-3.5" />
              验证中...
            </>
          ) : (
            '保存'
          )}
        </Button>
      </div>
    </div>
  );
}

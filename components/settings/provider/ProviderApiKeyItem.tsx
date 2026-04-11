import { useState } from 'react';
import { Eye, EyeOff, Check, X } from 'lucide-react';
import { getModels, complete, type KnownProvider } from '@mariozechner/pi-ai';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import type { ApiKeyCredential } from '@/lib/storage';

interface ProviderApiKeyItemProps {
  provider: string;
  label: string;
  description: string;
  credential?: ApiKeyCredential;
  onSave: (credential: ApiKeyCredential) => void;
}

export function ProviderApiKeyItem({
  provider,
  label,
  description,
  credential,
  onSave,
}: ProviderApiKeyItemProps) {
  const [key, setKey] = useState(credential?.apiKey ?? '');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<
    { type: 'success'; message: string } | { type: 'error'; message: string } | null
  >(null);

  const models = getModels(provider as KnownProvider);
  const firstModel = models[0];
  const modelCount = models.length;

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
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ type: 'error', message: `连接失败: ${message}` });
    } finally {
      setSaving(false);
    }
  };

  const renderStatus = () => {
    if (status) {
      return status.type === 'success' ? (
        <p className="flex items-center gap-1 text-xs text-success">
          <Check className="size-3" />
          {status.message}
        </p>
      ) : (
        <p className="flex items-center gap-1 text-xs text-destructive">
          <X className="size-3" />
          {status.message}
        </p>
      );
    }

    if (credential?.verified) {
      return (
        <p className="flex items-center gap-1 text-xs text-success">
          <Check className="size-3" />
          已连接 · {modelCount} 个模型
        </p>
      );
    }

    if (credential && !credential.verified) {
      return (
        <p className="text-xs text-yellow-500">
          凭据未验证
        </p>
      );
    }

    return <p className="text-xs text-muted-foreground">未配置</p>;
  };

  if (!firstModel) {
    return (
      <div className="space-y-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
        <p className="text-xs text-muted-foreground">无可用模型</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
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

      {renderStatus()}
    </div>
  );
}

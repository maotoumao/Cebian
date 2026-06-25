import { useState, useMemo, useEffect } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Unplug, Save } from "lucide-react";
import { getModels, complete } from "@earendil-works/pi-ai/compat";
import type { KnownProvider, Api, Model } from "@earendil-works/pi-ai";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { isCustomProvider } from "@/lib/providers/custom-models";
import { t } from "@/lib/i18n";
import type { ApiKeyCredential } from "@/lib/persistence/storage";

interface ProviderApiKeyItemProps {
  provider: string;
  label: string;
  models?: Model<Api>[];
  credential?: ApiKeyCredential;
  onSave: (credential: ApiKeyCredential) => void;
  onRemove?: () => void;
}

export function ProviderApiKeyItem({
  provider,
  label,
  models: modelsProp,
  credential,
  onSave,
  onRemove,
}: ProviderApiKeyItemProps) {
  const [key, setKey] = useState(credential?.apiKey ?? "");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);

  // 凭据由 storage 异步加载，首次挂载时 credential 往往还是 undefined（useStorageItem
  // 先返回 fallback）。等真实凭据到达后把它同步进本地输入框，否则保存过的 key 重进
  // 设置页会显示为空。仅在 credential.apiKey 变化时触发：凭据加载完成后，未保存的
  // 普通输入不会被覆盖（此时 credential.apiKey 不变）。
  useEffect(() => {
    setKey(credential?.apiKey ?? "");
  }, [credential?.apiKey]);

  const cheapestModel = useMemo(() => {
    try {
      const models = modelsProp ?? (isCustomProvider(provider) ? [] : (getModels(provider as KnownProvider) as Model<Api>[]));
      if (models.length === 0) return undefined;

      return models.reduce((min, m) =>
        m.cost.input + m.cost.output < min.cost.input + min.cost.output ? m : min,
      );
    } catch {
      return undefined;
    }
  }, [provider, modelsProp]);

  const handleSave = async () => {
    if (!cheapestModel || !key.trim()) return;

    setSaving(true);

    try {
      const result = await complete(
        cheapestModel,
        {
          messages: [
            { role: "user", content: "Reply only: ok", timestamp: Date.now() },
          ],
        },
        { apiKey: key, maxTokens: 5 },
      );

      // complete() resolves (not rejects) with an Error on failure
      if (result instanceof Error) {
        throw result;
      }

      const text = result.content
        .filter((b) => b.type === "text")
        .map((b) => ("text" in b ? b.text : ""))
        .join("");

      if (!text.toLowerCase().includes("ok")) {
        // 仅为进入 catch 走「失败也保存」分支；无具体原因，toast 只显示标题。
        throw new Error();
      }

      onSave({ authType: "apiKey", apiKey: key, verified: true });
    } catch (err) {
      // 连通性测试是脆弱的启发式（最便宜模型可能下架/限流/不听话回 "ok"），
      // 失败不应阻断保存：仍写入 verified:false，徒留黄色「未验证」徐章；
      // 有具体原因时（一次性信息，不持久化）用 toast 的 description 告知。
      console.error(`[ApiKey Verify] ${provider}:`, err);
      onSave({ authType: "apiKey", apiKey: key, verified: false });
      const reason = err instanceof Error && err.message ? err.message : undefined;
      toast.warning(t('provider.apiKey.savedUnverified'), reason ? { description: reason } : undefined);
    } finally {
      setSaving(false);
    }
  };

  const statusBadge = () => {
    if (saving) {
      return (
        <Badge
          role="status"
          variant="outline"
          className="text-blue-500 border-blue-500/20 bg-blue-500/5 text-[0.65rem] h-4 px-1.5"
        >
          {t('provider.status.verifying')}
        </Badge>
      );
    }
    if (credential?.verified) {
      return (
        <Badge
          role="status"
          variant="outline"
          className="text-success border-success/20 bg-success/5 text-[0.65rem] h-4 px-1.5"
        >
          {t('provider.status.connected')}
        </Badge>
      );
    }
    if (credential && !credential.verified) {
      return (
        <Badge
          role="status"
          variant="outline"
          className="text-yellow-500 border-yellow-500/20 bg-yellow-500/5 text-[0.65rem] h-4 px-1.5"
        >
          {t('provider.status.unverified')}
        </Badge>
      );
    }
    return (
      <Badge
        role="status"
        variant="outline"
        className="text-muted-foreground border-border text-[0.65rem] h-4 px-1.5"
      >
        {t('provider.status.notConfigured')}
      </Badge>
    );
  };

  if (!cheapestModel) {
    return (
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">{label}</p>
        <Badge
          variant="outline"
          className="text-muted-foreground border-border text-[0.65rem] h-4 px-1.5"
        >
          {t('provider.apiKey.noModels')}
        </Badge>
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
            type={showKey ? "text" : "password"}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={t('provider.apiKey.placeholder')}
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
            {showKey ? (
              <EyeOff className="size-3.5" />
            ) : (
              <Eye className="size-3.5" />
            )}
          </Button>
        </div>

        <Button
          size="icon"
          variant="ghost"
          disabled={saving || !key.trim()}
          onClick={handleSave}
          title={t('common.save')}
        >
          {saving ? (
            <Spinner className="size-3.5" />
          ) : (
            <Save className="size-3.5" />
          )}
        </Button>

        <Button
          size="icon"
          variant="ghost"
          className="text-destructive hover:text-destructive hover:bg-destructive/10"
          disabled={saving || !credential}
          onClick={() => {
            onRemove?.();
            setKey("");
          }}
          title={t('provider.apiKey.disconnect')}
        >
          <Unplug className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

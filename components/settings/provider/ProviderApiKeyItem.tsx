import { useState, useMemo, useEffect } from "react";
import { toast } from "sonner";
import { Unplug, Save } from "lucide-react";
import { complete } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all';
import type { Api, Model } from "@earendil-works/pi-ai";
import { PasswordInput } from "@/components/ui/password-input";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { isCustomProvider } from "@/lib/providers/custom-models";
import { API_KEY_CHECK_URLS } from "@/lib/providers/registry";
import { t } from "@/lib/i18n";
import type { ApiKeyCredential } from "@/lib/persistence/storage";

/** 拿 provider 的某个模型发一次极短补全，回复里有 "ok" 即视为 key 有效。 */
async function verifyKeyByCompletion(model: Model<Api>, apiKey: string): Promise<void> {
  const result = await complete(
    model,
    {
      messages: [
        { role: "user", content: "Reply only: ok", timestamp: Date.now() },
      ],
    },
    // 一次性请求：随机会话标识 + 不写缓存（同标题生成）。要求每个请求带会话标识的 provider
    // （如 OpenCode 的 x-opencode-session，#105）缺了会 400，探测会误判失败
    { apiKey, maxTokens: 5, sessionId: crypto.randomUUID(), cacheRetention: "none" },
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
}

/**
 * 用 provider 的鉴权接口校验 key（约定见 API_KEY_CHECK_URLS）：2xx 即有效，否则带上服务端
 * 给的原因抛错。10 秒超时与 fetchRemoteModels 一致，挂起也会落到「保存 + 未验证」。
 */
async function verifyKeyAtEndpoint(url: string, apiKey: string): Promise<void> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return;
  const body: unknown = await res.json().catch(() => undefined);
  const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
  throw new Error(
    typeof message === "string" && message ? message : t('errors.network.requestFailed', [res.status]),
  );
}

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
      const models = modelsProp ?? (isCustomProvider(provider) ? [] : (getBuiltinModels(provider as BuiltinProvider) as Model<Api>[]));
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
      // 有专用鉴权接口的 provider 走接口，其余拿最便宜的模型发一次补全
      const checkUrl = API_KEY_CHECK_URLS[provider];
      if (checkUrl) {
        await verifyKeyAtEndpoint(checkUrl, key);
      } else {
        await verifyKeyByCompletion(cheapestModel, key);
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
        <div className="flex-1">
          <PasswordInput
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={t('provider.apiKey.placeholder')}
          />
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

import { useState, useMemo } from "react";
import { Eye, EyeOff, Unplug, Save } from "lucide-react";
import {
  getModels,
  complete,
  type KnownProvider,
  type Api,
  type Model,
} from "@mariozechner/pi-ai";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import type { ApiKeyCredential } from "@/lib/storage";

interface ProviderApiKeyItemProps {
  provider: KnownProvider;
  label: string;
  credential?: ApiKeyCredential;
  onSave: (credential: ApiKeyCredential) => void;
  onRemove?: () => void;
}

export function ProviderApiKeyItem({
  provider,
  label,
  credential,
  onSave,
  onRemove,
}: ProviderApiKeyItemProps) {
  const [key, setKey] = useState(credential?.apiKey ?? "");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<
    | { type: "success"; message: string }
    | { type: "error"; message: string }
    | null
  >(null);

  const { cheapestModel, modelCount } = useMemo(() => {
    try {
      // Cast needed: getModels with union KnownProvider yields Model<never>[]
      // due to TS computing intersection of model IDs across all providers
      const models = getModels(provider) as Model<Api>[];
      if (models.length === 0) return { cheapestModel: undefined, modelCount: 0 };

      // Pick the cheapest model for connection testing
      const cheapest = models.reduce((min, m) =>
        m.cost.input + m.cost.output < min.cost.input + min.cost.output ? m : min,
      );

      return { cheapestModel: cheapest, modelCount: models.length };
    } catch {
      return { cheapestModel: undefined, modelCount: 0 };
    }
  }, [provider]);

  const handleSave = async () => {
    if (!cheapestModel || !key.trim()) return;

    setSaving(true);
    setStatus(null);

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
        throw new Error("验证失败：未收到预期响应");
      }

      onSave({ authType: "apiKey", apiKey: key, verified: true });
      setStatus({ type: "success", message: `已连接 · ${modelCount} 个模型` });
    } catch (err) {
      console.error(`[ApiKey Verify] ${provider}:`, err);
      setStatus({ type: "error", message: "连接失败" });
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
          验证中
        </Badge>
      );
    }
    if (status?.type === "error") {
      return (
        <Badge
          role="status"
          variant="outline"
          className="text-destructive border-destructive/20 bg-destructive/5 text-[0.65rem] h-4 px-1.5"
        >
          连接失败
        </Badge>
      );
    }
    if (status?.type === "success" || credential?.verified) {
      return (
        <Badge
          role="status"
          variant="outline"
          className="text-success border-success/20 bg-success/5 text-[0.65rem] h-4 px-1.5"
        >
          已连接
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
          未验证
        </Badge>
      );
    }
    return (
      <Badge
        role="status"
        variant="outline"
        className="text-muted-foreground border-border text-[0.65rem] h-4 px-1.5"
      >
        未配置
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
          无可用模型
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
          title="保存"
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
            setStatus(null);
          }}
          title="断开连接"
        >
          <Unplug className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

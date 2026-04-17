import { useState } from 'react';
import { ArrowLeft, Key } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  providerCredentials,
  customProviders as customProvidersStorage,
  userInstructions as userInstructionsStorage,
  maxRounds as maxRoundsStorage,
} from '@/lib/storage';
import { mergeCustomProviders } from '@/lib/custom-models';
import { PRESET_PROVIDERS } from '@/lib/constants';
import { ProviderSummary } from '@/components/settings/provider/ProviderSummary';
import { ProviderManagerDialog } from '@/components/settings/provider/ProviderManagerDialog';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  const [providers] = useStorageItem(providerCredentials, {});
  const [customProviderList] = useStorageItem(customProvidersStorage, []);
  const [currentInstructions, setCurrentInstructions] = useStorageItem(userInstructionsStorage, '');
  const [currentMaxRounds, setCurrentMaxRounds] = useStorageItem(maxRoundsStorage, 200);
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);

  const allCustomProviders = mergeCustomProviders(PRESET_PROVIDERS, customProviderList);

  const verifiedProviders = Object.entries(providers).filter(([, c]) => c.verified);

  return (
    <div
      className={`absolute inset-0 bg-background z-50 flex flex-col transition-transform duration-300 ease-out ${
        open ? 'translate-x-0' : 'translate-x-full'
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border">
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          <ArrowLeft className="size-5" />
        </Button>
        <span className="font-semibold">设置</span>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
        {/* Section 1: AI 提供商 */}
        <div>
          <h3 className="text-xs text-muted-foreground font-medium tracking-wide uppercase mb-3">
            AI 提供商
          </h3>
          {verifiedProviders.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <Key className="size-8 text-muted-foreground" />
              <p className="text-sm font-medium">尚未配置任何 AI 提供商</p>
              <p className="text-xs text-muted-foreground">添加 API Key 或登录以开始</p>
              <Button
                className="mt-2"
                size="sm"
                onClick={() => setProviderDialogOpen(true)}
              >
                配置提供商
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {verifiedProviders.slice(0, 5).map(([provider, credential]) => (
                <ProviderSummary
                  key={provider}
                  provider={provider}
                  credential={credential}
                  customProviders={allCustomProviders}
                />
              ))}
              <Button
                variant="outline"
                size="sm"
                className="w-full mt-1"
                onClick={() => setProviderDialogOpen(true)}
              >
                管理 AI 提供商
              </Button>
            </div>
          )}
        </div>

        <Separator className="my-1" />

        {/* Section 2: Agent */}
        <div>
          <h3 className="text-xs text-muted-foreground font-medium tracking-wide uppercase mb-3">
            Agent
          </h3>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-sm">自定义指引</Label>
              <p className="text-xs text-muted-foreground">
                追加到默认规则之后，用于调整回复语言、风格或角色。无法覆盖工具协议和安全规则。
              </p>
              <Textarea
                value={currentInstructions}
                onChange={(e) => setCurrentInstructions(e.target.value)}
                placeholder={'例如：\n- 用中文回复\n- 回答尽量简洁\n- 讨论代码时默认使用 TypeScript'}
                rows={4}
                maxLength={2000}
                className="text-xs max-h-48 overflow-y-auto"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-sm">最大对话轮数</Label>
              <p className="text-xs text-muted-foreground">超出后自动截断早期消息</p>
              <Input
                type="number"
                value={currentMaxRounds}
                onChange={(e) => setCurrentMaxRounds(Math.max(1, parseInt(e.target.value) || 200))}
                min={1}
                max={1000}
                className="w-24 h-8 text-sm"
              />
            </div>
          </div>
        </div>

        <Separator className="my-1" />

        {/* Section 3: 关于 */}
        <div>
          <h3 className="text-xs text-muted-foreground font-medium tracking-wide uppercase mb-3">
            关于
          </h3>
          <div className="space-y-1">
            <p className="text-sm font-medium">Cebian v0.1.0</p>
            <p className="text-xs text-muted-foreground">AI 浏览器侧边栏助手</p>
            <div className="flex gap-2 pt-1 text-xs text-muted-foreground">
              <a href="#" className="hover:text-foreground transition-colors">
                GitHub
              </a>
              <span>·</span>
              <a href="#" className="hover:text-foreground transition-colors">
                MIT License
              </a>
              <span>·</span>
              <a href="#" className="hover:text-foreground transition-colors">
                反馈
              </a>
            </div>
          </div>
        </div>
      </div>

      <ProviderManagerDialog
        open={providerDialogOpen}
        onOpenChange={setProviderDialogOpen}
      />
    </div>
  );
}

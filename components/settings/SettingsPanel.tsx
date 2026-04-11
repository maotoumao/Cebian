import { useState } from 'react';
import { ArrowLeft, Key } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  providerCredentials,
  customProviders as customProvidersStorage,
  cebianSettings,
  DEFAULT_SETTINGS,
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
  const [settings, setSettings] = useStorageItem(cebianSettings, DEFAULT_SETTINGS);
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

        {/* Section 2: 网络 */}
        <div>
          <h3 className="text-xs text-muted-foreground font-medium tracking-wide uppercase mb-3">
            网络
          </h3>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">CORS 代理</Label>
                <p className="text-xs text-muted-foreground">通过代理绕过跨域限制</p>
              </div>
              <Switch
                checked={settings.proxy.enabled}
                onCheckedChange={(enabled) =>
                  setSettings({ ...settings, proxy: { ...settings.proxy, enabled } })
                }
              />
            </div>
            {settings.proxy.enabled && (
              <Input
                placeholder="https://proxy.example.com"
                value={settings.proxy.url}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    proxy: { ...settings.proxy, url: e.target.value },
                  })
                }
              />
            )}
          </div>
        </div>

        <Separator className="my-1" />

        {/* Section 3: 行为 */}
        <div>
          <h3 className="text-xs text-muted-foreground font-medium tracking-wide uppercase mb-3">
            行为
          </h3>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">执行前确认</Label>
                <p className="text-xs text-muted-foreground">执行脚本前弹窗确认</p>
              </div>
              <Switch
                checked={settings.behavior.confirmBeforeExec}
                onCheckedChange={(confirmBeforeExec) =>
                  setSettings({
                    ...settings,
                    behavior: { ...settings.behavior, confirmBeforeExec },
                  })
                }
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">流式输出</Label>
                <p className="text-xs text-muted-foreground">实时显示 AI 回复</p>
              </div>
              <Switch
                checked={settings.behavior.streaming}
                onCheckedChange={(streaming) =>
                  setSettings({
                    ...settings,
                    behavior: { ...settings.behavior, streaming },
                  })
                }
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">后台任务持久化</Label>
                <p className="text-xs text-muted-foreground">
                  使用 Offscreen Document 保持定时任务
                </p>
              </div>
              <Switch
                checked={settings.behavior.backgroundPersist}
                onCheckedChange={(backgroundPersist) =>
                  setSettings({
                    ...settings,
                    behavior: { ...settings.behavior, backgroundPersist },
                  })
                }
              />
            </div>
          </div>
        </div>

        <Separator className="my-1" />

        {/* Section 4: 关于 */}
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

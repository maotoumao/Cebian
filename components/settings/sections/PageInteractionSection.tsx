import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  pageInteractionSettings,
  resolvePageInteractionSettings,
  providerCredentials,
  customProviders as customProvidersStorage,
  type PageInteractionSettings,
} from '@/lib/persistence/storage';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

// 翻译目标语言的 BCP-47 代码。标签在渲染时由 Intl.DisplayNames 用「各语言本名
// （endonym）」生成，故源码只含 ASCII 代码，无需为语言名维护三语翻译，任何界面语言
// 下都显示成该语言自己的写法。空串（跟随界面语言）作为单独首项在选择器里处理。
const TRANSLATE_TARGETS = [
  'en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt', 'it', 'ar',
] as const;

/** 用目标语言自身显示其语言名（endonym）；不支持时回退代码本身。 */
function endonym(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** 翻译目标语言选择器：Popover + 列表，首项为「跟随界面语言」（写回空串）。 */
function TranslateTargetSelector({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (target: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const currentLabel = value
    ? endonym(value)
    : t('settings.pageInteraction.translate.auto');

  const renderRow = (rowValue: string, label: string) => (
    <button
      key={rowValue || 'auto'}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none',
        'hover:bg-accent hover:text-accent-foreground',
        value === rowValue && 'bg-accent/50',
      )}
      onClick={() => {
        onSelect(rowValue);
        setOpen(false);
      }}
    >
      {label}
      <Check
        className={cn('ml-auto size-4', value === rowValue ? 'opacity-100' : 'opacity-0')}
      />
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="min-w-32 justify-between">
          {currentLabel}
          <ChevronDown data-icon />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-44 p-1" align="end">
        <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
          {renderRow('', t('settings.pageInteraction.translate.auto'))}
          {TRANSLATE_TARGETS.map((code) => renderRow(code, endonym(code)))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * PageInteractionSection — 页面交互设置。
 *
 * 控制注入页面的悬浮球与划词工具条：两块 UI 的显示开关、工具条专用模型（复用聊天的
 * `ModelSelector`，`inheritOption` 提供「跟随主模型」）、翻译目标语言（首项跟随界面语言）。
 */
export function PageInteractionSection() {
  const [stored, setStored] = useStorageItem(pageInteractionSettings, undefined);
  const [providers] = useStorageItem(providerCredentials, {});
  const [customProviderList] = useStorageItem(customProvidersStorage, []);

  const settings = resolvePageInteractionSettings(stored);
  const patch = (next: Partial<PageInteractionSettings>) =>
    setStored({ ...settings, ...next });

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.pageInteraction.title')}</h2>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="page-show-ball" className="text-sm">
            {t('settings.pageInteraction.ball.label')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.pageInteraction.ball.hint')}
          </p>
        </div>
        <Switch
          id="page-show-ball"
          checked={settings.showFloatingBall}
          onCheckedChange={(v) => patch({ showFloatingBall: v })}
          className="shrink-0"
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="page-show-toolbar" className="text-sm">
            {t('settings.pageInteraction.toolbar.label')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.pageInteraction.toolbar.hint')}
          </p>
        </div>
        <Switch
          id="page-show-toolbar"
          checked={settings.showSelectionToolbar}
          onCheckedChange={(v) => patch({ showSelectionToolbar: v })}
          className="shrink-0"
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label className="text-sm">{t('settings.pageInteraction.model.label')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.pageInteraction.model.hint')}
          </p>
        </div>
        <div className="shrink-0">
          <ModelSelector
            activeModel={settings.toolbarModel ?? null}
            configuredProviders={providers}
            customProviders={customProviderList}
            onSelect={(provider, modelId) => patch({ toolbarModel: { provider, modelId } })}
            inheritOption={{
              label: t('settings.pageInteraction.model.followMain'),
              onSelect: () => patch({ toolbarModel: undefined }),
            }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label className="text-sm">{t('settings.pageInteraction.translate.label')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.pageInteraction.translate.hint')}
          </p>
        </div>
        <div className="shrink-0">
          <TranslateTargetSelector
            value={settings.translateTarget}
            onSelect={(target) => patch({ translateTarget: target })}
          />
        </div>
      </div>
    </div>
  );
}

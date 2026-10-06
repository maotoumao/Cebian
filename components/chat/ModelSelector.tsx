import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getBuiltinModels, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all';
import type { Api, Model } from '@earendil-works/pi-ai';
import { AlertTriangle, Check, ChevronDown, Settings } from 'lucide-react';

import type { ModelIdentity, ProviderCredentials, CustomProviderConfig } from '@/lib/persistence/storage';
import { isCustomProvider, findCustomProvider } from '@/lib/providers/custom-models';
import { isUsableModel, listUsableModelGroups } from '@/lib/providers/usable-models';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/lib/i18n';

interface ModelSelectorProps {
  activeModel: ModelIdentity | null;
  configuredProviders: ProviderCredentials;
  customProviders: CustomProviderConfig[];
  onSelect: (provider: string, modelId: string) => void;
  /** 是否在底部展示「添加更多模型」入口（点击跳转设置）。设置页内复用时省略即隐藏。 */
  showAddModels?: boolean;
  /** 可选的列表首项（如「与对话模型相同」）；选中状态由 `activeModel == null` 推导。 */
  inheritOption?: { label: string; onSelect: () => void };
}

export function ModelSelector({
  activeModel,
  configuredProviders,
  customProviders,
  onSelect,
  showAddModels = false,
  inheritOption,
}: ModelSelectorProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [commandValue, setCommandValue] = useState('');

  const providerModels = useMemo(
    () => listUsableModelGroups(configuredProviders, customProviders),
    [configuredProviders, customProviders],
  );

  // 展示名：能查到就用友好名，查不到（模型已下架 / provider 配置已删）就退回 modelId
  // ——失效时也要让用户看清「坏掉的是哪一个」，而不是显示成未选择。
  const activeModelName = useMemo(() => {
    if (!activeModel) return null;

    // Try custom providers first
    if (isCustomProvider(activeModel.provider)) {
      const config = findCustomProvider(customProviders, activeModel.provider);
      const md = config?.models.find(m => m.modelId === activeModel.modelId);
      return md?.name ?? activeModel.modelId;
    }

    // Built-in provider
    try {
      const models = getBuiltinModels(activeModel.provider as BuiltinProvider) as Model<Api>[];
      return models.find(m => m.id === activeModel.modelId)?.name ?? activeModel.modelId;
    } catch {
      return activeModel.modelId;
    }
  }, [activeModel, customProviders]);

  // 选中的模型已不在可选列表里（被下架 / 自定义模型被删 / provider 凭据被移除）。判据与
  // 下拉列表同源，所以「列表里选不到」与「标为不可用」永远一致（issue #62）。
  const activeUnavailable = useMemo(
    () => !!activeModel && !isUsableModel(activeModel, configuredProviders, customProviders),
    [activeModel, configuredProviders, customProviders],
  );

  // 触发按钮文案：选了具体模型显示其名（`activeModelName` 仅在没选时为 null）；没选时
  // 有 inheritOption 则显示「继承」文案（如「与对话模型相同」），否则退回占位。
  const triggerLabel = activeModelName ?? inheritOption?.label ?? t('chat.model.select');

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (next) {
          setCommandValue(activeModel ? `${activeModel.provider}/${activeModel.modelId}` : '__inherit__');
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className={cn('text-xs h-7 max-w-44', activeUnavailable && 'text-destructive')}
          title={activeUnavailable ? t('errors.modelUnavailable') : undefined}
        >
          {activeUnavailable && <AlertTriangle data-icon className="shrink-0" />}
          <span className="truncate min-w-0">{triggerLabel}</span>
          <ChevronDown data-icon className="shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        {/* Unavailable-model notice: the user opened this to re-pick — say why, up top */}
        {activeUnavailable && (
          <div className="flex items-start gap-2 border-b px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="size-3.5 shrink-0 translate-y-px" />
            <span className="min-w-0 break-words">{t('errors.modelUnavailable')}</span>
          </div>
        )}
        <Command value={commandValue} onValueChange={setCommandValue}>
          <CommandInput placeholder={t('chat.model.searchPlaceholder')} />
          <CommandList>
            <CommandEmpty>{t('chat.model.notFound')}</CommandEmpty>
            {inheritOption && (
              <>
                <CommandGroup>
                  <CommandItem
                    value="__inherit__"
                    keywords={[inheritOption.label]}
                    onSelect={() => {
                      inheritOption.onSelect();
                      setOpen(false);
                    }}
                  >
                    {inheritOption.label}
                    <Check
                      className={cn('ml-auto', activeModel == null ? 'opacity-100' : 'opacity-0')}
                    />
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            {providerModels.map((group, i) => (
              <div key={group.provider}>
                {i > 0 && <CommandSeparator />}
                <CommandGroup heading={group.label}>
                  {group.models.map(model => (
                    <CommandItem
                      key={model.id}
                      value={`${group.provider}/${model.id}`}
                      onSelect={() => {
                        onSelect(group.provider, model.id);
                        setOpen(false);
                      }}
                    >
                      {model.name}
                      <Check
                        className={cn(
                          'ml-auto',
                          activeModel?.provider === group.provider &&
                            activeModel?.modelId === model.id
                            ? 'opacity-100'
                            : 'opacity-0',
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </div>
            ))}
            {showAddModels && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={() => {
                      navigate('/settings');
                      setOpen(false);
                    }}
                  >
                    <Settings data-icon />
                    {t('chat.model.addMore')}
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

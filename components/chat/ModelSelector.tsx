import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getBuiltinModels, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all';
import type { Api, Model } from '@earendil-works/pi-ai';
import { Check, ChevronDown, Settings } from 'lucide-react';

import type { ModelIdentity, ProviderCredentials, CustomProviderConfig } from '@/lib/persistence/storage';
import { isCustomProvider, findCustomProvider } from '@/lib/providers/custom-models';
import { listUsableModelGroups } from '@/lib/providers/usable-models';
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

  const activeModelName = useMemo(() => {
    if (!activeModel) return null;

    // Try custom providers first
    if (isCustomProvider(activeModel.provider)) {
      const config = findCustomProvider(customProviders, activeModel.provider);
      if (config) {
        const md = config.models.find(m => m.modelId === activeModel.modelId);
        return md?.name ?? activeModel.modelId;
      }
      return null;
    }

    // Built-in provider
    try {
      const models = getBuiltinModels(activeModel.provider as BuiltinProvider) as Model<Api>[];
      return models.find(m => m.id === activeModel.modelId)?.name ?? activeModel.modelId;
    } catch {
      return null;
    }
  }, [activeModel, customProviders]);

  // 触发按钮文案：选了具体模型显示其名；activeModel 为 null 时，有 inheritOption 则
  // 显示「继承」文案（如「与对话模型相同」），否则退回「选择模型」占位。
  const triggerLabel = activeModel
    ? (activeModelName ?? t('chat.model.select'))
    : (inheritOption?.label ?? t('chat.model.select'));

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
        <Button variant="ghost" size="xs" className="text-xs h-7 max-w-44">
          <span className="truncate min-w-0">{triggerLabel}</span>
          <ChevronDown data-icon className="shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
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

import { useMemo, useState } from 'react';
import { getModels, type KnownProvider, type Api, type Model } from '@mariozechner/pi-ai';
import { Check, ChevronDown, Settings } from 'lucide-react';

import type { ActiveModel, ProviderCredentials, CustomProviderConfig } from '@/lib/storage';
import { isCustomProvider, findCustomProvider, getCustomModels } from '@/lib/custom-models';
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

interface ModelSelectorProps {
  activeModel: ActiveModel | null;
  configuredProviders: ProviderCredentials;
  customProviders: CustomProviderConfig[];
  onSelect: (provider: string, modelId: string) => void;
  onOpenSettings: () => void;
}

export function ModelSelector({
  activeModel,
  configuredProviders,
  customProviders,
  onSelect,
  onOpenSettings,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);

  const providerModels = useMemo(() => {
    const verified = Object.entries(configuredProviders).filter(
      ([, cred]) => cred.verified,
    );
    const groups: { provider: string; label: string; models: Model<Api>[] }[] = [];

    for (const [provider] of verified) {
      if (isCustomProvider(provider)) {
        // Custom/preset provider — look up in customProviders list + presets
        const config = findCustomProvider(customProviders, provider);
        if (config) {
          groups.push({
            provider,
            label: config.name,
            models: getCustomModels(config),
          });
        }
      } else {
        // Built-in pi-ai provider
        try {
          const models = getModels(provider as KnownProvider) as Model<Api>[];
          if (models.length > 0) {
            groups.push({ provider, label: provider, models });
          }
        } catch {
          // Unknown provider, skip
        }
      }
    }
    return groups;
  }, [configuredProviders, customProviders]);

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
      const models = getModels(activeModel.provider as KnownProvider) as Model<Api>[];
      return models.find(m => m.id === activeModel.modelId)?.name ?? activeModel.modelId;
    } catch {
      return null;
    }
  }, [activeModel, customProviders]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="text-[0.7rem]">
          {activeModelName ?? '选择模型'}
          <ChevronDown data-icon />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="搜索模型…" />
          <CommandList>
            <CommandEmpty>未找到模型</CommandEmpty>
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
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  onOpenSettings();
                  setOpen(false);
                }}
              >
                <Settings data-icon />
                前往设置添加更多提供商
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

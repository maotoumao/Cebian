import { useMemo, useState } from 'react';
import { getModels, type KnownProvider } from '@mariozechner/pi-ai';
import { Check, ChevronDown, Settings } from 'lucide-react';

import type { ActiveModel, ProviderCredentials } from '@/lib/storage';
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
  onSelect: (provider: string, modelId: string) => void;
  onOpenSettings: () => void;
}

export function ModelSelector({
  activeModel,
  configuredProviders,
  onSelect,
  onOpenSettings,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);

  const providerModels = useMemo(() => {
    const verified = Object.entries(configuredProviders).filter(
      ([, cred]) => cred.verified,
    );
    return verified.map(([provider]) => ({
      provider,
      models: getModels(provider as KnownProvider),
    })).filter(g => g.models.length > 0);
  }, [configuredProviders]);

  const activeModelName = useMemo(() => {
    if (!activeModel) return null;
    try {
      const models = getModels(activeModel.provider as KnownProvider);
      return models.find(m => m.id === activeModel.modelId)?.name ?? activeModel.modelId;
    } catch {
      return null;
    }
  }, [activeModel]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="text-xs">
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
                <CommandGroup heading={group.provider}>
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

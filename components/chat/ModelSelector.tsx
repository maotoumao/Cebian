import { useMemo, useState } from 'react';
import { getModels } from '@earendil-works/pi-ai/compat';
import type { KnownProvider, Api, Model } from '@earendil-works/pi-ai';
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
      const models = getModels(activeModel.provider as KnownProvider) as Model<Api>[];
      return models.find(m => m.id === activeModel.modelId)?.name ?? activeModel.modelId;
    } catch {
      return null;
    }
  }, [activeModel, customProviders]);

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (next && activeModel) {
          setCommandValue(`${activeModel.provider}/${activeModel.modelId}`);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="text-[0.7rem]">
          {activeModelName ?? t('chat.model.select')}
          <ChevronDown data-icon />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command value={commandValue} onValueChange={setCommandValue}>
          <CommandInput placeholder={t('chat.model.searchPlaceholder')} />
          <CommandList>
            <CommandEmpty>{t('chat.model.notFound')}</CommandEmpty>
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
                {t('chat.model.addMore')}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

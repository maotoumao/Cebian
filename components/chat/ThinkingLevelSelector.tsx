import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

import type { ThinkingLevel } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/lib/i18n';

// Pairs each level with a getLabel() resolver so locale changes work
// at render time. See SectionNav for the same pattern + rationale.
const THINKING_LEVELS = [
  { value: 'off', getLabel: () => t('chat.thinking.levels.off') },
  { value: 'minimal', getLabel: () => t('chat.thinking.levels.minimal') },
  { value: 'low', getLabel: () => t('chat.thinking.levels.low') },
  { value: 'medium', getLabel: () => t('chat.thinking.levels.medium') },
  { value: 'high', getLabel: () => t('chat.thinking.levels.high') },
] as const satisfies readonly { value: ThinkingLevel; getLabel: () => string }[];

interface ThinkingLevelSelectorProps {
  level: ThinkingLevel;
  onSelect: (level: ThinkingLevel) => void;
}

export function ThinkingLevelSelector({
  level,
  onSelect,
}: ThinkingLevelSelectorProps) {
  const [open, setOpen] = useState(false);
  const currentLabel = THINKING_LEVELS.find(l => l.value === level)?.getLabel() ?? level;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="text-[0.7rem]">
          {t('chat.thinking.label', [currentLabel])}
          <ChevronDown data-icon />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-36 p-1" align="start">
        <div className="flex flex-col gap-0.5">
          {THINKING_LEVELS.map(item => (
            <button
              key={item.value}
              className={cn(
                'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none',
                'hover:bg-accent hover:text-accent-foreground',
                level === item.value && 'bg-accent/50',
              )}
              onClick={() => {
                onSelect(item.value);
                setOpen(false);
              }}
            >
              {item.getLabel()}
              <Check
                className={cn(
                  'ml-auto size-4',
                  level === item.value ? 'opacity-100' : 'opacity-0',
                )}
              />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

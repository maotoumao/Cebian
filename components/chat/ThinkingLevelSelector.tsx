import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

import type { ThinkingLevel } from '@/lib/persistence/storage';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/lib/i18n';

// 全 7 档的 label 解析器：用 getLabel() 而非静态串，让运行时切语言即时生效（见 SectionNav）
// Record<ThinkingLevel> 保证穷举——pi 未来加档位这里会编译报错，提示补文案
const LEVEL_LABELS: Record<ThinkingLevel, () => string> = {
  off: () => t('chat.thinking.levels.off'),
  minimal: () => t('chat.thinking.levels.minimal'),
  low: () => t('chat.thinking.levels.low'),
  medium: () => t('chat.thinking.levels.medium'),
  high: () => t('chat.thinking.levels.high'),
  xhigh: () => t('chat.thinking.levels.xhigh'),
  max: () => t('chat.thinking.levels.max'),
};

interface ThinkingLevelSelectorProps {
  /** 当前档位（应为 levels 之一，由父级夹好） */
  level: ThinkingLevel;
  /** 当前模型支持的档位子集，按强度升序；只渲染这些 */
  levels: ThinkingLevel[];
  onSelect: (level: ThinkingLevel) => void;
}

export function ThinkingLevelSelector({
  level,
  levels,
  onSelect,
}: ThinkingLevelSelectorProps) {
  const [open, setOpen] = useState(false);
  const currentLabel = LEVEL_LABELS[level]();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="text-xs h-7">
          {t('chat.thinking.label', [currentLabel])}
          <ChevronDown data-icon />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-36 p-1" align="start">
        <div className="flex flex-col gap-0.5">
          {levels.map((value) => (
            <button
              key={value}
              className={cn(
                'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none',
                'hover:bg-accent hover:text-accent-foreground',
                level === value && 'bg-accent/50',
              )}
              onClick={() => {
                onSelect(value);
                setOpen(false);
              }}
            >
              {LEVEL_LABELS[value]()}
              <Check
                className={cn(
                  'ml-auto size-4',
                  level === value ? 'opacity-100' : 'opacity-0',
                )}
              />
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

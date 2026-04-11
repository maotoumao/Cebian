import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

import type { ThinkingLevel } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

const THINKING_LEVELS = [
  { value: 'off', label: '关闭' },
  { value: 'minimal', label: '最小' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
] as const;

interface ThinkingLevelSelectorProps {
  level: ThinkingLevel;
  onSelect: (level: ThinkingLevel) => void;
}

export function ThinkingLevelSelector({
  level,
  onSelect,
}: ThinkingLevelSelectorProps) {
  const [open, setOpen] = useState(false);
  const currentLabel = THINKING_LEVELS.find(l => l.value === level)?.label ?? level;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="text-[0.7rem]">
          思考: {currentLabel}
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
              {item.label}
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

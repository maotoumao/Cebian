import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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

/**
 * 翻译目标语言选择器：Popover + 列表，首项为「跟随界面语言」（写回空串）。
 * 只服务内置「翻译」动作——它是那个动作的专属参数，故住在动作编辑页而非全局设置区。
 */
export function TranslateTargetSelector({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (target: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const currentLabel = value ? endonym(value) : t('settings.pageInteraction.translate.auto');

  const renderRow = (rowValue: string, label: string) => (
    <button
      key={rowValue || 'auto'}
      type="button"
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
      <Check className={cn('ml-auto size-4', value === rowValue ? 'opacity-100' : 'opacity-0')} />
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

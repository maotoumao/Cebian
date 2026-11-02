import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

/** 单选项：`lang` 只在选项文字与界面语言不同（如语言自称）时给出。 */
interface RadioOption<T extends string> {
  value: T;
  getLabel: () => string;
  lang?: string;
}

/** 横排单选组：一行放几个短选项。 */
function InlineRadioGroup<T extends string>({
  value,
  options,
  onChange,
  labelId,
  describedBy,
  disabled,
}: {
  value: T;
  options: RadioOption<T>[];
  onChange: (value: T) => void;
  labelId: string;
  describedBy?: string;
  disabled?: boolean;
}) {
  const idPrefix = useId();
  return (
    <RadioGroup
      value={value}
      onValueChange={(v) => onChange(v as T)}
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      disabled={disabled}
      className="flex flex-wrap gap-x-5 gap-y-2"
    >
      {options.map((o) => (
        <div key={o.value} className="flex items-center gap-2">
          <RadioGroupItem value={o.value} id={`${idPrefix}-${o.value}`} />
          <Label htmlFor={`${idPrefix}-${o.value}`} lang={o.lang} className="text-sm font-normal">
            {o.getLabel()}
          </Label>
        </div>
      ))}
    </RadioGroup>
  );
}

// ─── 公开 API ───

export { InlineRadioGroup };
export type { RadioOption };

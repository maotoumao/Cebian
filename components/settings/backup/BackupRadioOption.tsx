import { RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';

interface BackupRadioOptionProps {
  /** RadioGroupItem 的值。 */
  value: string;
  /** 是否当前选中（仅用于卡片高亮，选中态由外层 RadioGroup 驱动）。 */
  active: boolean;
  title: string;
  hint: string;
}

/**
 * 卡片式单选项：标题 + 副标题描述，外层套 RadioGroupItem 提供语义与键盘导航。
 * 创建备份（模式）与恢复备份（策略）两个弹窗共用，避免样式漂移。
 */
export function BackupRadioOption({ value, active, title, hint }: BackupRadioOptionProps) {
  return (
    <label
      className={cn(
        'flex w-full items-start gap-2.5 rounded-md border p-2.5 cursor-pointer transition-colors',
        active ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50',
      )}
    >
      <RadioGroupItem value={value} className="mt-0.5" />
      <span className="space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useStorageItem } from '@/hooks/useStorageItem';
import { userInstructions as userInstructionsStorage } from '@/lib/storage';

/**
 * InstructionsSection — user-authored system-prompt addendum.
 * Migrated from the old SettingsPanel "自定义指引" block (stage 2b).
 */
export function InstructionsSection() {
  const [currentInstructions, setCurrentInstructions] = useStorageItem(userInstructionsStorage, '');

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-base font-semibold">指引</h2>

      <div className="space-y-2">
        <Label htmlFor="user-instructions" className="text-sm">自定义指引</Label>
        <p className="text-xs text-muted-foreground">
          追加到默认规则之后，用于调整回复语言、风格或角色。无法覆盖工具协议和安全规则。
        </p>
        <Textarea
          id="user-instructions"
          value={currentInstructions}
          onChange={(e) => setCurrentInstructions(e.target.value)}
          placeholder={'例如：\n- 用中文回复\n- 回答尽量简洁\n- 讨论代码时默认使用 TypeScript'}
          rows={8}
          maxLength={2000}
          className="text-xs min-h-64 max-h-96 overflow-y-auto"
        />
        <p className="text-xs text-muted-foreground text-right" aria-live="polite">
          {currentInstructions.length} / 2000
        </p>
      </div>
    </div>
  );
}

import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useStorageItem } from '@/hooks/useStorageItem';
import { userInstructions as userInstructionsStorage } from '@/lib/storage';
import { t } from '@/lib/i18n';

/**
 * InstructionsSection — user-authored system-prompt addendum.
 * Migrated from the old SettingsPanel "settings.instructions.label" block (stage 2b).
 */
export function InstructionsSection() {
  const [currentInstructions, setCurrentInstructions] = useStorageItem(userInstructionsStorage, '');

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.instructions.title')}</h2>

      <div className="space-y-2">
        <Label htmlFor="user-instructions" className="text-sm">{t('settings.instructions.label')}</Label>
        <p className="text-xs text-muted-foreground">
          {t('settings.instructions.hint')}
        </p>
        <Textarea
          id="user-instructions"
          value={currentInstructions}
          onChange={(e) => setCurrentInstructions(e.target.value)}
          placeholder={t('settings.instructions.placeholder')}
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

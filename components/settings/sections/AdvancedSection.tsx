import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useStorageItem } from '@/hooks/useStorageItem';
import { maxRounds as maxRoundsStorage } from '@/lib/storage';
import { t } from '@/lib/i18n';

/**
 * AdvancedSection — low-level agent behaviour knobs.
 * Migrated from the old SettingsPanel "settings.advanced.maxRounds.label" block (stage 2b).
 */
export function AdvancedSection() {
  const [currentMaxRounds, setCurrentMaxRounds] = useStorageItem(maxRoundsStorage, 200);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.advanced.title')}</h2>

      <div className="space-y-2">
        <Label htmlFor="max-rounds" className="text-sm">{t('settings.advanced.maxRounds.label')}</Label>
        <p className="text-xs text-muted-foreground">{t('settings.advanced.maxRounds.hint')}</p>
        <Input
          id="max-rounds"
          type="number"
          value={currentMaxRounds}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') return; // allow clear-to-retype without clobbering state
            const parsed = parseInt(raw, 10);
            if (Number.isNaN(parsed)) return;
            setCurrentMaxRounds(Math.min(1000, Math.max(1, parsed)));
          }}
          min={1}
          max={1000}
          className="w-28 h-8 text-sm"
        />
      </div>
    </div>
  );
}

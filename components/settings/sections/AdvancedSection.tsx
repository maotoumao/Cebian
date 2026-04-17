import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useStorageItem } from '@/hooks/useStorageItem';
import { maxRounds as maxRoundsStorage } from '@/lib/storage';

/**
 * AdvancedSection — low-level agent behaviour knobs.
 * Migrated from the old SettingsPanel "最大对话轮数" block (stage 2b).
 */
export function AdvancedSection() {
  const [currentMaxRounds, setCurrentMaxRounds] = useStorageItem(maxRoundsStorage, 200);

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-base font-semibold">高级</h2>

      <div className="space-y-2">
        <Label htmlFor="max-rounds" className="text-sm">最大对话轮数</Label>
        <p className="text-xs text-muted-foreground">超出后自动截断早期消息</p>
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

import { useEffect, useMemo, useState } from 'react';
import { Lock } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup } from '@/components/ui/radio-group';
import { BackupRadioOption } from '@/components/settings/backup/BackupRadioOption';
import { t } from '@/lib/i18n';
import type { BackupCategory, BackupManifest, RestoreStrategy } from '@/lib/backup/types';

interface RestorePreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 已读取并校验的 manifest（恢复前预览，不需要口令）。 */
  manifest: BackupManifest | null;
  /** 用户确认后回调：要恢复的分类、策略、口令（加密包才有）。 */
  onConfirm: (args: { categories: BackupCategory[]; strategy: RestoreStrategy; password?: string }) => void;
  /** 恢复进行中：禁用确认按钮，防止重复提交（含破坏性 replace）。 */
  submitting?: boolean;
}

/** manifest 里实际包含的分类（included=true）。预览只让用户在这些里挑。 */
function includedCategories(manifest: BackupManifest): BackupCategory[] {
  const c = manifest.categories;
  const out: BackupCategory[] = [];
  if (c.sessions.included) out.push('sessions');
  if (c.settings.included) out.push('settings');
  if (c.skillsPrompts.included) out.push('skillsPrompts');
  if (c.memories.included) out.push('memories');
  if (c.credentials.included) out.push('credentials');
  return out;
}

const CATEGORY_LABEL: Record<BackupCategory, () => string> = {
  sessions: () => t('settings.backup.restore.catSessions'),
  settings: () => t('settings.backup.restore.catSettings'),
  skillsPrompts: () => t('settings.backup.restore.catSkillsPrompts'),
  memories: () => t('settings.backup.restore.catMemories'),
  credentials: () => t('settings.backup.restore.catCredentials'),
};

/**
 * 恢复预览弹窗。展示备份来源与各分类，让用户挑要恢复的分类 + 合并/替换策略，
 * 加密包额外要口令。强确认（替换 / 含密钥）在调用方的 onConfirm 里处理。
 */
export function RestorePreviewDialog({ open, onOpenChange, manifest, onConfirm, submitting }: RestorePreviewDialogProps) {
  const available = useMemo(() => (manifest ? includedCategories(manifest) : []), [manifest]);
  const [selected, setSelected] = useState<Set<BackupCategory>>(new Set());
  const [strategy, setStrategy] = useState<RestoreStrategy>('merge');
  const [password, setPassword] = useState('');

  // 每次打开（或换包）时重置：默认勾选全部可恢复分类、合并策略、清空口令。
  // 关闭时清空口令，避免明文口令滞留在 React state。
  useEffect(() => {
    if (!open || !manifest) {
      setPassword('');
      return;
    }
    setSelected(new Set(available));
    setStrategy('merge');
    setPassword('');
  }, [open, manifest, available]);

  if (!manifest) return null;

  const toggle = (cat: BackupCategory, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(cat);
      else next.delete(cat);
      return next;
    });
  };

  const count = (cat: BackupCategory): number | undefined => {
    if (cat === 'sessions') return manifest.categories.sessions.count;
    // credentials 不展示数字：无统一且解耦的「条数」口径（见 CredentialsCategorySummary）。
    if (cat === 'skillsPrompts') return manifest.categories.skillsPrompts.fileCount;
    if (cat === 'memories') return manifest.categories.memories.fileCount;
    return undefined;
  };

  const anySelected = selected.size > 0;
  const needsPassword = manifest.encrypted;

  const confirm = () => {
    onConfirm({
      categories: [...selected],
      strategy,
      password: needsPassword && password ? password : undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('settings.backup.restore.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {/* source meta */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t('settings.backup.restore.source', [manifest.appVersion])}</span>
            {manifest.encrypted && (
              <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5">
                <Lock className="size-3" />
                {t('settings.backup.restore.encrypted')}
              </span>
            )}
          </div>

          {/* password (encrypted only) */}
          {needsPassword && (
            <div className="space-y-1.5">
              <Label htmlFor="restore-password" className="text-sm">{t('settings.backup.restore.passwordLabel')}</Label>
              <Input
                id="restore-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('settings.backup.restore.passwordPlaceholder')}
                className="h-8 text-sm"
              />
            </div>
          )}

          {/* categories */}
          <div className="space-y-2">
            <Label className="text-sm">{t('settings.backup.restore.include')}</Label>
            {available.map((cat) => {
              const n = count(cat);
              return (
                <label key={cat} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={selected.has(cat)} onCheckedChange={(v) => toggle(cat, v === true)} />
                  <span>
                    {CATEGORY_LABEL[cat]()}
                    {n !== undefined && <span className="text-muted-foreground"> ({n})</span>}
                  </span>
                </label>
              );
            })}
          </div>

          {/* strategy */}
          <div className="space-y-2">
            <Label className="text-sm">{t('settings.backup.restore.strategy')}</Label>
            <RadioGroup
              value={strategy}
              onValueChange={(v) => setStrategy(v as RestoreStrategy)}
              aria-label={t('settings.backup.restore.strategy')}
              className="gap-2"
            >
              <BackupRadioOption
                value="merge"
                active={strategy === 'merge'}
                title={t('settings.backup.restore.merge')}
                hint={t('settings.backup.restore.mergeHint')}
              />
              <BackupRadioOption
                value="replace"
                active={strategy === 'replace'}
                title={t('settings.backup.restore.replace')}
                hint={t('settings.backup.restore.replaceHint')}
              />
            </RadioGroup>
          </div>

          {!anySelected && (
            <p className="text-xs text-destructive">{t('settings.backup.restore.nothingSelected')}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button
            variant={strategy === 'replace' ? 'destructive' : 'default'}
            onClick={confirm}
            disabled={!anySelected || (needsPassword && !password) || submitting}
          >
            {t('settings.backup.restore.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

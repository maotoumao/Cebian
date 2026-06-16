import { useEffect, useMemo, useState } from 'react';
import { Info, TriangleAlert } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup } from '@/components/ui/radio-group';
import { BackupRadioOption } from '@/components/settings/backup/BackupRadioOption';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { BackupCategory, BackupOptions } from '@/lib/backup/types';

type Mode = 'full' | 'partial';

/** 备份名 / 文件名里禁止的字符：文件系统 / URL 危险字符与控制符。中文 / 空格 /
 *  `-` / `_` / `.` 等均放行。输入层与文件名生成层（backupFileName）共用同一黑名单。 */
// eslint-disable-next-line no-control-regex
export const FORBIDDEN_NAME_CHARS = /[/\\:*?"<>|\x00-\x1f]/;
/** 备份名长度上限（字符数）。 */
export const MAX_BACKUP_NAME_LENGTH = 60;

/** 默认备份名：`<本地化前缀> YYYY-MM-DD HH-mm`。时分用 `-` 而非 `:`，避开文件名
 *  非法字符，让显示名与最终文件名一致。净化为空时 backupFileName 也回退到此。 */
export function defaultBackupName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
  return t('settings.backup.create.defaultName', [ts]);
}

interface CreateBackupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 用户确认后回调，收到组装好的备份选项。 */
  onConfirm: (options: BackupOptions) => void;
}

/**
 * 创建备份弹窗。收集名称 / 描述 / 模式 / 分类勾选 / 工作区子选项 / 加密口令，
 * 产出 BackupOptions 交给调用方（本地下载或 WebDAV 上传共用）。
 */
export function CreateBackupDialog({ open, onOpenChange, onConfirm }: CreateBackupDialogProps) {
  const [name, setName] = useState(defaultBackupName);
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<Mode>('full');
  const [sessions, setSessions] = useState(true);
  const [includeWorkspaces, setIncludeWorkspaces] = useState(true);
  const [settings, setSettings] = useState(true);
  const [skillsPrompts, setSkillsPrompts] = useState(true);
  const [credentials, setCredentials] = useState(false);
  const [encrypt, setEncrypt] = useState(false);
  const [password, setPassword] = useState('');

  // 每次打开时重置表单：刷新默认名、清空口令，避免上次的选择 / 明文口令滞留。
  useEffect(() => {
    if (!open) return;
    setName(defaultBackupName());
    setDescription('');
    setMode('full');
    setSessions(true);
    setIncludeWorkspaces(true);
    setSettings(true);
    setSkillsPrompts(true);
    setCredentials(false);
    setEncrypt(false);
    setPassword('');
  }, [open]);

  // 完整备份 = 全部分类（含密钥）；部分备份 = 用户勾选。
  const effective = useMemo(() => {
    if (mode === 'full') {
      return {
        sessions: true,
        includeWorkspaces: true,
        settings: true,
        skillsPrompts: true,
        credentials: true,
      };
    }
    return { sessions, includeWorkspaces, settings, skillsPrompts, credentials };
  }, [mode, sessions, includeWorkspaces, settings, skillsPrompts, credentials]);

  const hasCredentials = effective.credentials;
  const anySelected =
    effective.sessions || effective.settings || effective.skillsPrompts || effective.credentials;

  // 名称非法：含禁用字符或超长。空名不算非法（confirm 会回退默认名）。“允许输入但
  // 标红”：不静默剔除字符，只提示并禁用确认，让用户自行修改。
  const nameInvalid = FORBIDDEN_NAME_CHARS.test(name) || name.length > MAX_BACKUP_NAME_LENGTH;

  const confirm = () => {
    const categories: BackupCategory[] = [];
    if (effective.sessions) categories.push('sessions');
    if (effective.settings) categories.push('settings');
    if (effective.skillsPrompts) categories.push('skillsPrompts');
    if (effective.credentials) categories.push('credentials');

    onConfirm({
      name: name.trim() || defaultBackupName(),
      description: description.trim(),
      categories,
      includeWorkspaces: effective.sessions && effective.includeWorkspaces,
      password: encrypt && password ? password : undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('settings.backup.create.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {/* name + description */}
          <div className="space-y-1.5">
            <Label htmlFor="backup-name" className="text-sm">{t('settings.backup.create.nameLabel')}</Label>
            <Input
              id="backup-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={nameInvalid}
              className="h-8 text-sm"
            />
            {nameInvalid && (
              <p className="text-xs text-destructive">
                {t('settings.backup.create.nameInvalid', [String(MAX_BACKUP_NAME_LENGTH)])}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="backup-desc" className="text-sm">{t('settings.backup.create.descriptionLabel')}</Label>
            <Textarea
              id="backup-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('settings.backup.create.descriptionPlaceholder')}
              rows={2}
              className="text-sm resize-none"
            />
          </div>

          {/* mode */}
          <div className="space-y-2">
            <Label className="text-sm">{t('settings.backup.create.mode')}</Label>
            <RadioGroup
              value={mode}
              onValueChange={(v) => setMode(v as Mode)}
              aria-label={t('settings.backup.create.mode')}
              className="gap-2"
            >
              <BackupRadioOption
                value="full"
                active={mode === 'full'}
                title={t('settings.backup.create.modeFull')}
                hint={t('settings.backup.create.modeFullHint')}
              />
              <BackupRadioOption
                value="partial"
                active={mode === 'partial'}
                title={t('settings.backup.create.modePartial')}
                hint={t('settings.backup.create.modePartialHint')}
              />
            </RadioGroup>

            {mode === 'partial' && (
              <div className="pl-1 space-y-2 pt-1">
                <CategoryRow checked={sessions} onChange={setSessions} label={t('settings.backup.create.catSessions')} />
                <div className="pl-6">
                  <CategoryRow
                    checked={sessions && includeWorkspaces}
                    onChange={setIncludeWorkspaces}
                    disabled={!sessions}
                    label={t('settings.backup.create.catWorkspaces')}
                  />
                </div>
                <CategoryRow checked={settings} onChange={setSettings} label={t('settings.backup.create.catSettings')} />
                <CategoryRow checked={skillsPrompts} onChange={setSkillsPrompts} label={t('settings.backup.create.catSkillsPrompts')} />
                <CategoryRow
                  checked={credentials}
                  onChange={setCredentials}
                  label={t('settings.backup.create.catCredentials')}
                  hint={t('settings.backup.create.catCredentialsHint')}
                />
                {!anySelected && (
                  <p className="text-xs text-destructive">{t('settings.backup.create.atLeastOne')}</p>
                )}
              </div>
            )}
          </div>

          {/* encryption */}
          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center justify-between">
              <Label htmlFor="backup-encrypt" className="text-sm">{t('settings.backup.create.encrypt')}</Label>
              <Switch id="backup-encrypt" checked={encrypt} onCheckedChange={setEncrypt} />
            </div>
            {encrypt && (
              <div className="space-y-1">
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('settings.backup.create.passwordPlaceholder')}
                  className="h-8 text-sm"
                />
                <p className="text-xs text-muted-foreground">{t('settings.backup.create.passwordHint')}</p>
              </div>
            )}
          </div>

          {/* banner */}
          <div className="flex gap-2 rounded-md bg-muted/50 p-2.5 text-xs text-muted-foreground">
            <Info className="size-4 shrink-0 mt-px" />
            <span>{t('settings.backup.create.bannerInfo')}</span>
          </div>
          {hasCredentials && (
            <div className="flex gap-2 rounded-md bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
              <TriangleAlert className="size-4 shrink-0 mt-px" />
              <span>{t('settings.backup.create.bannerWarning')}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={confirm} disabled={!anySelected || nameInvalid || (encrypt && !password)}>
            {t('common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface CategoryRowProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}

function CategoryRow({ checked, onChange, label, hint, disabled }: CategoryRowProps) {
  return (
    <label className={cn('flex items-start gap-2 text-sm', disabled && 'opacity-50')}>
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        disabled={disabled}
        className="mt-0.5"
      />
      <span className="space-y-0.5">
        <span className="block">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

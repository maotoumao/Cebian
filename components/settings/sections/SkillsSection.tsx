import { useCallback, useMemo, useRef } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { Blocks, Download, FolderDown, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  FileWorkspace,
  type FileWorkspaceAction, type FileWorkspaceHandle,
} from './FileWorkspace';
import { encodeRelPath } from '@/lib/vfs';
import { CEBIAN_SKILLS_DIR } from '@/lib/constants';
import { settingsFilePanelWidth } from '@/lib/storage';
import { createSkillTemplate } from '@/lib/ai-config/skill-creator';
import {
  exportSkillPackage,
  exportAllSkillsPackage,
  inspectSkillPackage,
  SkillPackageError,
  type SkillImportResult,
} from '@/lib/ai-config/skill-transfer';
import { showDialog } from '@/lib/dialog';
import { vfs, normalizePath } from '@/lib/vfs';
import { downloadFile } from '@/lib/utils';
import type { SettingsOutletContext } from '@/components/settings/SettingsLayout';
import { t } from '@/lib/i18n';

/**
 * SkillsSection — multi-file agent skill manager under /settings/skills[/*].
 *
 * Supports nested paths (e.g. `my-skill/scripts/foo.js`). Edits and imports
 * go through `vfs.writeFile`, which broadcasts change events across
 * extension contexts so the background scanner's cached skill index is
 * invalidated automatically — no manual notification needed.
 *
 * Contributes four toolbar actions: create, import, export current, export
 * all. The domain scaffolding lives in `lib/ai-config/skill-creator.ts` and
 * `lib/ai-config/skill-transfer.ts` so `FileWorkspace` stays free of any
 * business concepts.
 */
export function SkillsSection() {
  const { basePath, breakpoint } = useOutletContext<SettingsOutletContext>();
  const params = useParams();
  const navigate = useNavigate();
  const workspaceRef = useRef<FileWorkspaceHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const splat = params['*'] ?? '';
  const relativePath = splat || undefined;
  // The first path segment of the currently-selected file IS the skill
  // directory name (skills are flat under CEBIAN_SKILLS_DIR). Used to
  // enable / target the "Export current" action.
  const currentSkillName = relativePath ? relativePath.split('/')[0] : undefined;

  const handleSelect = useCallback((rel: string | null) => {
    if (rel) {
      navigate(`${basePath}/skills/${encodeRelPath(rel)}`, { replace: true });
    } else {
      navigate(`${basePath}/skills`, { replace: true });
    }
  }, [basePath, navigate]);

  const handleCreateSkill = useCallback(async () => {
    const { entryFile } = await createSkillTemplate(CEBIAN_SKILLS_DIR);
    workspaceRef.current?.refresh();
    workspaceRef.current?.selectAbs(entryFile);
  }, []);

  // ─── Import / Export ──────────────────────────────────────────────

  /** Localized message for a SkillPackageError, falling back to the raw
   *  message for non-domain errors. WXT generates separate overloads for
   *  keys with vs without `$N` placeholders, so we dispatch by the code's
   *  shape rather than passing one variable to a single `t()` call. */
  const formatError = useCallback((err: unknown): string => {
    if (err instanceof SkillPackageError) {
      const arg = err.arg ?? '';
      switch (err.code) {
        case 'invalid':           return t('errors.skillPackage.invalid');
        case 'tooLarge':          return t('errors.skillPackage.tooLarge');
        case 'tooManyFiles':      return t('errors.skillPackage.tooManyFiles');
        case 'missingEntry':      return t('errors.skillPackage.missingEntry');
        case 'parseFrontmatter':  return t('errors.skillPackage.parseFrontmatter');
        case 'unsafePath':            return t('errors.skillPackage.unsafePath', [arg]);
        case 'unsupportedPermission': return t('errors.skillPackage.unsupportedPermission', [arg]);
        case 'invalidName':           return t('errors.skillPackage.invalidName', [arg]);
        case 'reservedName':          return t('errors.skillPackage.reservedName', [arg]);
      }
    }
    return err instanceof Error ? err.message : String(err);
  }, []);

  const handleExportCurrent = useCallback(async () => {
    if (!currentSkillName) return;
    try {
      const skillsRoot = normalizePath(CEBIAN_SKILLS_DIR);
      const blob = await exportSkillPackage(`${skillsRoot}/${currentSkillName}`);
      downloadFile(`${currentSkillName}.cebian-skill.zip`, blob, 'application/zip');
      toast.success(t('settings.skills.exportSuccess', [currentSkillName]));
    } catch (err) {
      toast.error(formatError(err));
    }
  }, [currentSkillName, formatError]);

  const handleExportAll = useCallback(async () => {
    try {
      const { blob, count } = await exportAllSkillsPackage();
      const date = new Date().toISOString().slice(0, 10);
      downloadFile(`cebian-skills-backup-${date}.zip`, blob, 'application/zip');
      toast.success(t('settings.skills.exportAllSuccess', count));
    } catch (err) {
      if (err instanceof SkillPackageError && err.code === 'missingEntry') {
        // No exportable skills — surface as a neutral info, not an error.
        toast(t('settings.skills.exportEmpty'));
        return;
      }
      toast.error(formatError(err));
    }
  }, [formatError]);

  /** Caller for the import preview dialog. Refreshes the file tree and
   *  shows a localized success toast based on package type. The scanner's
   *  cached skill index is invalidated automatically via the vfs change
   *  events emitted by the underlying writes — no manual notification
   *  needed. */
  const handleImported = useCallback((result: SkillImportResult) => {
    workspaceRef.current?.refresh();
    if (result.installed.length === 1) {
      toast.success(t('settings.skills.importSuccess', [result.installed[0].targetDirName]));
    } else {
      toast.success(t('settings.skills.importSuccessBackup', result.installed.length));
    }
  }, []);

  const handleImportFile = useCallback(async (file: File) => {
    try {
      const preview = await inspectSkillPackage(file);
      showDialog('skill-import-preview', {
        blob: file,
        preview,
        onImported: handleImported,
        onError: (err) => toast.error(formatError(err)),
      });
    } catch (err) {
      toast.error(formatError(err));
    }
  }, [formatError, handleImported]);

  const handleImportClick = useCallback(() => {
    // Reset the input so re-picking the same file still fires onChange.
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleImportFile(file);
  }, [handleImportFile]);

  const toolbarActions = useMemo<FileWorkspaceAction[]>(() => [
    {
      id: 'new-skill',
      icon: Blocks,
      label: t('settings.skills.create'),
      separatorBefore: true,
      onSelect: handleCreateSkill,
    },
    {
      id: 'import-skill',
      icon: Upload,
      label: t('settings.skills.import'),
      onSelect: handleImportClick,
    },
    {
      id: 'export-current-skill',
      icon: Download,
      label: t('settings.skills.exportCurrent'),
      disabled: !currentSkillName,
      onSelect: handleExportCurrent,
    },
    {
      id: 'export-all-skills',
      icon: FolderDown,
      label: t('settings.skills.exportAll'),
      onSelect: handleExportAll,
    },
  ], [handleCreateSkill, handleImportClick, handleExportCurrent, handleExportAll, currentSkillName]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-6 pt-6 pb-4 shrink-0 border-b border-border">
        <h2 className="text-base font-semibold">{t('settings.skills.title')}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          {t('settings.skills.hint')}
        </p>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,application/zip"
        onChange={handleFileInputChange}
        className="hidden"
        aria-hidden
      />
      <FileWorkspace
        ref={workspaceRef}
        root={CEBIAN_SKILLS_DIR}
        relativePath={relativePath}
        onSelectRelative={handleSelect}
        allowNewFolder
        panelWidthStorage={settingsFilePanelWidth}
        compactMode={breakpoint === 'compact'}
        className="flex-1"
        toolbarActions={toolbarActions}
      />
    </div>
  );
}


import { useCallback, useMemo, useRef } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { Blocks, Download, FolderDown, Upload } from 'lucide-react';
import { toast } from 'sonner';
import {
  FileWorkspace, encodeRelPath,
  type FileWorkspaceAction, type FileWorkspaceHandle,
} from './FileWorkspace';
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
import type { SettingsOutletContext } from '@/components/settings/SettingsLayout';
import { t } from '@/lib/i18n';

/**
 * SkillsSection — multi-file agent skill manager under /settings/skills[/*].
 *
 * Supports nested paths (e.g. `my-skill/scripts/foo.js`). On save, notifies
 * the background service worker to clear its cached skill index.
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

  const handleSave = useCallback(() => {
    // Background caches the skill index; invalidate it so next agent turn re-reads.
    try { chrome.runtime.sendMessage({ type: 'invalidate_skill_index' }); } catch { /* ignore */ }
  }, []);

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

  /** Trigger a browser download for the given blob. Uses an ephemeral
   *  anchor + object URL since the project has no existing download
   *  helper and chrome.downloads requires the optional `downloads`
   *  permission. */
  const triggerDownload = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer revoke so the click has a chance to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  const handleExportCurrent = useCallback(async () => {
    if (!currentSkillName) return;
    try {
      const skillsRoot = normalizePath(CEBIAN_SKILLS_DIR);
      const blob = await exportSkillPackage(`${skillsRoot}/${currentSkillName}`);
      triggerDownload(blob, `${currentSkillName}.cebian-skill.zip`);
      toast.success(t('settings.skills.exportSuccess', [currentSkillName]));
    } catch (err) {
      toast.error(formatError(err));
    }
  }, [currentSkillName, formatError, triggerDownload]);

  const handleExportAll = useCallback(async () => {
    try {
      const { blob, count } = await exportAllSkillsPackage();
      const date = new Date().toISOString().slice(0, 10);
      triggerDownload(blob, `cebian-skills-backup-${date}.zip`);
      toast.success(t('settings.skills.exportAllSuccess', count));
    } catch (err) {
      if (err instanceof SkillPackageError && err.code === 'missingEntry') {
        // No exportable skills — surface as a neutral info, not an error.
        toast(t('settings.skills.exportEmpty'));
        return;
      }
      toast.error(formatError(err));
    }
  }, [formatError, triggerDownload]);

  /** Caller for the import preview dialog. Refreshes the file tree and
   *  shows a localized success toast based on package type. */
  const handleImported = useCallback((result: SkillImportResult) => {
    workspaceRef.current?.refresh();
    // Best-effort: notify the background to drop its cached skill index.
    try { chrome.runtime.sendMessage({ type: 'invalidate_skill_index' }); } catch { /* ignore */ }
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
        onSave={handleSave}
        allowNewFolder
        panelWidthStorage={settingsFilePanelWidth}
        compactMode={breakpoint === 'compact'}
        className="flex-1"
        toolbarActions={toolbarActions}
      />
    </div>
  );
}


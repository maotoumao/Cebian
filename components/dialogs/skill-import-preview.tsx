import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileCode, ShieldAlert } from 'lucide-react';
import { DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { closeDialog, showConfirm } from '@/lib/dialog';
import { t } from '@/lib/i18n';
import {
  importSkillPackage,
  SkillPackageError,
  type SkillImportPreview,
  type SkillImportPreviewItem,
  type SkillImportResult,
} from '@/lib/ai-config/skill-transfer';

/** Props passed via the dialog registry. */
interface SkillImportPreviewDialogProps {
  /** The blob the user selected — re-sent to `importSkillPackage` after the
   *  user picks a conflict strategy (we don't trust the preview's data). */
  blob: Blob;
  /** Result of `inspectSkillPackage(blob)` — purely for display. */
  preview: SkillImportPreview;
  /** Called once the import succeeds, with the install result. The caller
   *  is responsible for refreshing the file tree and showing a success
   *  toast (the dialog only handles its own close + error toast). */
  onImported: (result: SkillImportResult) => void;
  /** Called when an import attempt throws a `SkillPackageError` so the
   *  caller can surface a localized toast. The dialog still closes. */
  onError: (err: SkillPackageError | Error) => void;
}

/** Format a byte count as KB / MB with 1 decimal. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Visual classification of a permission string for the badge variant. */
function classifyPermission(perm: string): 'sensitive' | 'normal' {
  // `page.executeJs` and any `chrome.<ns>` permission can run code or read
  // user state, so they get the destructive badge to match how the agent
  // sandbox treats them at runtime.
  return perm === 'page.executeJs' || perm.startsWith('chrome.') ? 'sensitive' : 'normal';
}

function PreviewItem({ item }: { item: SkillImportPreviewItem }) {
  return (
    <div className="border border-border rounded-md p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium truncate">{item.name}</div>
          {item.name !== item.sourceDirName && (
            <div className="text-[11px] text-muted-foreground truncate">{item.sourceDirName}</div>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground shrink-0 flex items-center gap-1.5">
          <FileCode className="size-3" />
          {t('settings.skills.importDialog.fileCount', item.fileCount)}
          <span>·</span>
          <span>{formatBytes(item.totalBytes)}</span>
        </div>
      </div>

      {item.description && (
        <div className="text-xs text-muted-foreground line-clamp-3">{item.description}</div>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="text-[11px] font-medium text-muted-foreground">
          {t('settings.skills.importDialog.permissionsHeading')}
        </div>
        {item.permissions.length === 0 ? (
          <div className="text-[11px] text-muted-foreground">
            {t('settings.skills.importDialog.permissionsNone')}
          </div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {item.permissions.map((p) => (
              <Badge
                key={p}
                variant={classifyPermission(p) === 'sensitive' ? 'destructive' : 'secondary'}
                className="font-mono text-[10px]"
              >
                {p}
              </Badge>
            ))}
          </div>
        )}
      </div>

      {item.hasScripts && (
        <div className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <ShieldAlert className="size-3" />
          {t('settings.skills.importDialog.hasScriptsWarning')}
        </div>
      )}

      {item.conflicts && (
        <div className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-3 mt-0.5 shrink-0" />
          <span>
            {t('settings.skills.importDialog.conflictNotice', [item.sourceDirName, item.targetDirName])}
          </span>
        </div>
      )}
    </div>
  );
}

export function SkillImportPreviewDialog({
  blob,
  preview,
  onImported,
  onError,
}: SkillImportPreviewDialogProps) {
  const [busy, setBusy] = useState(false);
  // Used to suppress the success/error callback when the dialog gets
  // unmounted (ESC, overlay click, X) while an import is still running.
  // The on-disk write still completes — we just don't notify the parent
  // toolbar to refresh, since the user dismissed the UI.
  //
  // NOTE: `useRef(true)` alone is insufficient under React 19 StrictMode,
  // which mounts → cleans up → re-mounts in dev. The cleanup of the first
  // pass would flip the ref to `false` and the re-mount would never reset
  // it, leaving every callback path silently no-op'd. Re-assert `true` on
  // every effect run so both the StrictMode and HMR cases are correct.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const isBackup = preview.packageType === 'cebian.skills.backup';
  const hasConflict = preview.items.some((it) => it.conflicts);
  const conflictNames = preview.items.filter((it) => it.conflicts).map((it) => it.sourceDirName);

  const runImport = async (strategy: 'rename' | 'overwrite') => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await importSkillPackage(blob, { conflictStrategy: strategy });
      if (mountedRef.current) {
        onImported(result);
        closeDialog();
      }
    } catch (err) {
      if (mountedRef.current) {
        onError(err instanceof Error ? err : new Error(String(err)));
        closeDialog();
      }
    } finally {
      // Safe even after unmount — React 19 silently drops state updates on
      // unmounted components without the legacy warning.
      setBusy(false);
    }
  };

  const handleOverwrite = async () => {
    if (busy) return;
    // Lock the preview's other buttons while the confirm AlertDialog is open
    // so the user can't kick off `runImport('rename')` underneath it.
    setBusy(true);
    let confirmed = false;
    try {
      confirmed = await showConfirm({
        title: t('settings.skills.importDialog.confirmOverwriteTitle'),
        // Format the conflict-name list in JS so the i18n string keeps a
        // single `$1` placeholder per locale and translators don't have to
        // know about a join-glue contract.
        description: t(
          'settings.skills.importDialog.confirmOverwriteDescription',
          [conflictNames.join(', ')],
        ),
        destructive: true,
      });
    } finally {
      if (!confirmed) setBusy(false);
    }
    if (confirmed) await runImport('overwrite');
  };

  return (
    <>
      <DialogHeader className="shrink-0 p-4 pb-3">
        <DialogTitle>
          {t(isBackup
            ? 'settings.skills.importDialog.titleBackup'
            : 'settings.skills.importDialog.titleSingle')}
        </DialogTitle>
        <DialogDescription>
          {isBackup
            ? t('settings.skills.importDialog.skillCount', preview.items.length)
            : t('settings.skills.importDialog.fileCount', preview.items[0]?.fileCount ?? 0)}
        </DialogDescription>
      </DialogHeader>

      <div className="px-4 overflow-auto flex-1 min-h-0 flex flex-col gap-2">
        {preview.items.map((item) => (
          <PreviewItem key={item.sourceDirName} item={item} />
        ))}
      </div>

      <DialogFooter className="shrink-0 p-4 pt-3 gap-2">
        <Button variant="ghost" onClick={() => closeDialog()} disabled={busy}>
          {t('common.cancel')}
        </Button>
        {hasConflict && (
          <Button variant="destructive" onClick={handleOverwrite} disabled={busy}>
            {t('settings.skills.importDialog.overwrite')}
          </Button>
        )}
        <Button onClick={() => runImport('rename')} disabled={busy}>
          {hasConflict
            ? t('settings.skills.importDialog.keepBoth')
            : t('common.confirm')}
        </Button>
      </DialogFooter>
    </>
  );
}

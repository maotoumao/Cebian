import { useCallback, useEffect, useRef, useState } from 'react';
import { Cloud, DatabaseBackup, Download, Loader2, RefreshCw, RotateCcw, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { CreateBackupDialog } from '@/components/settings/backup/CreateBackupDialog';
import { RestorePreviewDialog } from '@/components/settings/backup/RestorePreviewDialog';
import { WebDavConnectionForm } from '@/components/settings/backup/WebDavConnectionForm';
import { createBackup } from '@/lib/backup/collect';
import { inspectBackup, restoreBackup, RestoreError, type RestoreResult } from '@/lib/backup/restore';
import { BackupArchiveError } from '@/lib/backup/archive';
import {
  type WebDavSnapshot,
  deleteSnapshot,
  downloadSnapshot,
  listSnapshots,
  uploadSnapshot,
  webdavErrorMessage,
} from '@/lib/backup/webdav';
import { useStorageItem } from '@/hooks/useStorageItem';
import { webdavConfig, type WebDavConfig } from '@/lib/storage';
import { downloadFile } from '@/lib/utils';
import { showConfirm } from '@/lib/dialog';
import { t } from '@/lib/i18n';
import type {
  BackupCategory,
  BackupManifest,
  BackupOptions,
  RestoreStrategy,
} from '@/lib/backup/types';

/** 备份文件名：`cebian-backup-YYYY-MM-DD-HHmm.zip`。本地下载与 WebDAV 上传共用。 */
function backupFileName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `cebian-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.zip`;
}

/** 快照文件字节数转人类可读（B / KB / MB）；未知大小返回 undefined。 */
function formatSnapshotSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 把恢复 / 解包 / 读 manifest 抛出的错误统一翻译成可展示文案。覆盖全部已知错误码，
 *  认不出的才退回原始 message。供「选文件预览」与「确认恢复」两处共用，口径一致。 */
function restoreErrorMessage(err: unknown): string {
  if (err instanceof BackupArchiveError) {
    if (err.code === 'wrongPassword') return t('settings.backup.restore.wrongPassword');
    if (err.code === 'passwordRequired') return t('settings.backup.restore.passwordRequired');
    // invalid / unsafePath：容器结构损坏或路径不安全。
    return t('settings.backup.restore.invalidFile');
  }
  if (err instanceof RestoreError) {
    if (err.code === 'incompatibleVersion') return t('settings.backup.restore.incompatible');
    // corruptBackup：容器可读但 payload 内容损坏 / 缺失 / 解析失败。
    return t('settings.backup.restore.corrupt');
  }
  return `${t('settings.backup.restore.failed')}: ${err instanceof Error ? err.message : String(err)}`;
}

/** 收集恢复过程中「跳过」的逐项摘要（如「会话 3 · 文件 5」）。跳过只发生在合并模式
 *  （会话按 updatedAt LWW、文件按 path+mtime LWW）。无跳过返回空串，调用方据此在
 *  「恢复完成」与「部分恢复完成」之间二选一。 */
function skippedSummary(result: RestoreResult): string {
  const parts: string[] = [];
  if (result.sessions && result.sessions.skipped > 0) {
    parts.push(t('settings.backup.restore.skippedSessions', [result.sessions.skipped]));
  }
  if (result.vfs && result.vfs.skipped > 0) {
    parts.push(t('settings.backup.restore.skippedFiles', [result.vfs.skipped]));
  }
  return parts.join(' · ');
}

type CreateTarget = 'local' | 'webdav';

/**
 * BackupSection — 设置里的「备份与恢复」区块，含本地备份与 WebDAV 两块。
 *
 * 创建（CreateBackupDialog）与恢复（RestorePreviewDialog）的弹窗 / 流程为两块共用：
 * 创建按 `createTarget` 决定下载到本地还是上传到 WebDAV；恢复无论来自本地文件还是
 * WebDAV 快照，都先把字节喂给 `beginRestore` 走同一套预览 + 策略 + 强确认。
 */
export function BackupSection() {
  const [createOpen, setCreateOpen] = useState(false);
  const [createTarget, setCreateTarget] = useState<CreateTarget>('local');
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // 同步重入闸：耗时操作（创建 / 恢复 / 上传 / 删除）共用。`busy` 异步落到 UI 之前，
  // 连点可能让两次操作都进来；用 ref 在事件处理首行同步挡掉。
  const busyRef = useRef(false);
  // 选中文件 / 快照的字节与已校验的 manifest，在恢复弹窗确认时使用。
  const pendingBytes = useRef<Uint8Array | null>(null);
  const [pendingManifest, setPendingManifest] = useState<BackupManifest | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // WebDAV 连接与快照列表状态。
  const [config, setConfig] = useStorageItem<WebDavConfig | null>(webdavConfig, null);
  const [editingConnection, setEditingConnection] = useState(false);
  const [snapshots, setSnapshots] = useState<WebDavSnapshot[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(false);
  const [snapshotsError, setSnapshotsError] = useState<string | null>(null);
  // 快照列表的「最新一次加载」序号：只有最新请求能落盘，避免旧请求晚到覆盖新结果。
  const loadGenRef = useRef(0);
  // 未配置连接或正在编辑时显示连接表单，否则显示快照列表。
  const showConnectionForm = !config || editingConnection;

  // 抢占式闸：已有耗时操作在跑则直接拒绝（返回 false），否则置忙。配对 endBusy。
  const beginBusy = useCallback((): boolean => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    return true;
  }, []);
  const endBusy = useCallback(() => {
    busyRef.current = false;
    setBusy(false);
  }, []);

  // 把字节喂给恢复预览：inspectBackup 校验格式 / 版本，通过则打开恢复弹窗。本地文件与
  // WebDAV 快照恢复都经此入口。
  const beginRestore = useCallback((bytes: Uint8Array) => {
    try {
      const manifest = inspectBackup(bytes);
      pendingBytes.current = bytes;
      setPendingManifest(manifest);
      setRestoreOpen(true);
    } catch (err) {
      toast.error(restoreErrorMessage(err));
    }
  }, []);

  // 拉取 WebDAV 快照列表，失败转成可展示文案存进 snapshotsError。只有最新一次请求的
  // 结果会落盘（loadGenRef），避免重叠加载 / 切换连接时旧请求晚到覆盖新结果。
  const loadSnapshots = useCallback(async (cfg: WebDavConfig) => {
    const gen = ++loadGenRef.current;
    setSnapshotsLoading(true);
    setSnapshotsError(null);
    try {
      const list = await listSnapshots(cfg);
      if (gen === loadGenRef.current) setSnapshots(list);
    } catch (err) {
      if (gen === loadGenRef.current) setSnapshotsError(webdavErrorMessage(err));
    } finally {
      if (gen === loadGenRef.current) setSnapshotsLoading(false);
    }
  }, []);

  // 创建备份：本地下载或上传到 WebDAV，由 createTarget 决定。
  const handleCreate = useCallback(
    async (options: BackupOptions) => {
      setCreateOpen(false);
      if (!beginBusy()) return;
      try {
        const bytes = await createBackup(options);
        if (createTarget === 'webdav') {
          if (!config) throw new Error(t('settings.backup.webdav.notConfigured'));
          const name = backupFileName();
          await uploadSnapshot(config, name, bytes);
          toast.success(t('settings.backup.webdav.uploadSuccess'));
          await loadSnapshots(config);
        } else {
          downloadFile(
            backupFileName(),
            new Blob([bytes as BlobPart], { type: 'application/zip' }),
            'application/zip',
          );
          toast.success(t('settings.backup.create.success'));
        }
      } catch (err) {
        const msg = createTarget === 'webdav' ? webdavErrorMessage(err) : (err instanceof Error ? err.message : String(err));
        toast.error(`${t('settings.backup.create.failed')}: ${msg}`);
      } finally {
        endBusy();
      }
    },
    [createTarget, config, loadSnapshots, beginBusy, endBusy],
  );

  // 选文件 → 读字节 → 走 beginRestore。
  const handleFilePicked = useCallback(
    async (file: File) => {
      if (!beginBusy()) return;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        beginRestore(bytes);
      } catch (err) {
        toast.error(`${t('settings.backup.restore.failed')}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        endBusy();
      }
    },
    [beginRestore, beginBusy, endBusy],
  );

  const handleRestoreConfirm = useCallback(
    async (args: { categories: BackupCategory[]; strategy: RestoreStrategy; password?: string }) => {
      const bytes = pendingBytes.current;
      if (!bytes) return;
      // 首行同步置忙，挡住重复提交（含破坏性 replace）。强确认 / 恢复全程持忙。
      if (!beginBusy()) return;
      try {
        // 强确认：替换（破坏性）与含密钥各自有风险，兼顾两者时用合并文案。
        const hasCredentials = args.categories.includes('credentials');
        const isReplace = args.strategy === 'replace';
        if (isReplace) {
          const ok = await showConfirm({
            title: t('settings.backup.restore.confirmReplaceTitle'),
            description: hasCredentials
              ? t('settings.backup.restore.confirmReplaceCredentialsBody')
              : t('settings.backup.restore.confirmReplaceBody'),
            destructive: true,
          });
          if (!ok) return;
        } else if (hasCredentials) {
          const ok = await showConfirm({
            title: t('settings.backup.restore.confirmCredentialsTitle'),
            description: t('settings.backup.restore.confirmCredentialsBody'),
          });
          if (!ok) return;
        }

        const result = await restoreBackup(bytes, args.password, { strategy: args.strategy, categories: args.categories });
        // 成功后才关闭并清理 pending（含字节）。
        setRestoreOpen(false);
        pendingBytes.current = null;
        setPendingManifest(null);
        // 有跳过 → 「部分恢复完成（跳过 …）」；无跳过 → 「恢复完成」。
        const skipped = skippedSummary(result);
        if (skipped) {
          toast.success(t('settings.backup.restore.partialSuccess', [skipped]));
        } else {
          toast.success(t('settings.backup.restore.success'));
        }
      } catch (err) {
        // 失败发生在写入前 / 中：弹窗保持打开，留住已选文件 / 分类 / 策略，让用户修正
        // （如重输口令）后重试，不丢上下文。文案按错误码统一映射。
        toast.error(restoreErrorMessage(err));
      } finally {
        endBusy();
      }
    },
    [beginBusy, endBusy],
  );

  // 关闭恢复弹窗（取消 / 点 X / 成功）时，清掉待恢复的字节与 manifest，避免备份
  // 字节滞留内存。
  const handleRestoreOpenChange = useCallback((next: boolean) => {
    setRestoreOpen(next);
    if (!next) {
      pendingBytes.current = null;
      setPendingManifest(null);
    }
  }, []);

  // ─── WebDAV ───

  // 配置就绪且不在编辑态时拉取快照列表。
  useEffect(() => {
    if (config && !editingConnection) void loadSnapshots(config);
  }, [config, editingConnection, loadSnapshots]);

  const handleSaveConnection = useCallback(
    async (cfg: WebDavConfig) => {
      await setConfig(cfg);
      setEditingConnection(false);
      toast.success(t('settings.backup.webdav.savedConnection'));
    },
    [setConfig],
  );

  const handleRestoreSnapshot = useCallback(
    async (name: string) => {
      if (!config) return;
      if (!beginBusy()) return;
      try {
        const bytes = await downloadSnapshot(config, name);
        beginRestore(bytes);
      } catch (err) {
        toast.error(`${t('settings.backup.restore.failed')}: ${webdavErrorMessage(err)}`);
      } finally {
        endBusy();
      }
    },
    [config, beginRestore, beginBusy, endBusy],
  );

  const handleDeleteSnapshot = useCallback(
    async (name: string) => {
      if (!config) return;
      if (!beginBusy()) return;
      try {
        const ok = await showConfirm({
          title: t('settings.backup.webdav.deleteConfirmTitle'),
          description: t('settings.backup.webdav.deleteConfirmBody', [name]),
          destructive: true,
        });
        if (!ok) return;
        await deleteSnapshot(config, name);
        toast.success(t('settings.backup.webdav.deleteSuccess'));
        await loadSnapshots(config);
      } catch (err) {
        toast.error(`${t('settings.backup.webdav.deleteFailed')}: ${webdavErrorMessage(err)}`);
      } finally {
        endBusy();
      }
    },
    [config, loadSnapshots, beginBusy, endBusy],
  );

  const openCreate = useCallback((target: CreateTarget) => {
    setCreateTarget(target);
    setCreateOpen(true);
  }, []);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.backup.title')}</h2>

      {/* Local backup */}
      <section className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-center gap-2">
          <DatabaseBackup className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">{t('settings.backup.local.title')}</h3>
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.backup.local.description')}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => openCreate('local')} disabled={busy}>
            <Download className="size-4" />
            {t('settings.backup.local.create')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            <Upload className="size-4" />
            {t('settings.backup.local.restore')}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // 复位 input value，使重复选同一文件也能再次触发 change。
              e.target.value = '';
              if (file) void handleFilePicked(file);
            }}
          />
        </div>
      </section>

      {/* WebDAV backup */}
      <section className="space-y-3 rounded-lg border border-border p-4">
        <div className="flex items-center gap-2">
          <Cloud className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">{t('settings.backup.webdav.title')}</h3>
        </div>
        <p className="text-xs text-muted-foreground">{t('settings.backup.webdav.description')}</p>

        {showConnectionForm ? (
          <WebDavConnectionForm
            initial={config}
            onSave={handleSaveConnection}
            onCancel={config ? () => setEditingConnection(false) : undefined}
          />
        ) : (
          <div className="space-y-3">
            {/* connection summary + actions */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 text-xs text-muted-foreground">
                <span className="font-mono break-all">{config!.url}</span>
                <span className="break-all"> · {config!.directory || '/'}</span>
              </div>
              <Button size="xs" variant="ghost" onClick={() => setEditingConnection(true)} disabled={busy}>
                {t('settings.backup.webdav.changeConnection')}
              </Button>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => openCreate('webdav')} disabled={busy}>
                <Upload className="size-4" />
                {t('settings.backup.webdav.backupNow')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => config && void loadSnapshots(config)}
                disabled={busy || snapshotsLoading}
              >
                {snapshotsLoading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                {t('settings.backup.webdav.refresh')}
              </Button>
            </div>

            {/* snapshot list */}
            {snapshotsError ? (
              <p className="text-xs text-destructive">{snapshotsError}</p>
            ) : snapshotsLoading ? (
              <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border py-6 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t('settings.backup.webdav.loading')}
              </div>
            ) : snapshots.length === 0 ? (
              <div className="flex items-center justify-center rounded-md border border-dashed border-border py-6 text-xs text-muted-foreground">
                {t('settings.backup.webdav.noSnapshots')}
              </div>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {snapshots.map((s) => (
                  <li key={s.name} className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">{s.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {s.lastModified ? new Date(s.lastModified).toLocaleString() : '—'}
                        {formatSnapshotSize(s.size) ? ` · ${formatSnapshotSize(s.size)}` : ''}
                      </p>
                    </div>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void handleRestoreSnapshot(s.name)}
                      disabled={busy}
                      title={t('settings.backup.webdav.restoreAction')}
                    >
                      <RotateCcw className="size-3.5" />
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void handleDeleteSnapshot(s.name)}
                      disabled={busy}
                      title={t('settings.backup.webdav.deleteAction')}
                    >
                      <Trash2 className="size-3.5 text-destructive" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <CreateBackupDialog open={createOpen} onOpenChange={setCreateOpen} onConfirm={handleCreate} />
      <RestorePreviewDialog
        open={restoreOpen}
        onOpenChange={handleRestoreOpenChange}
        manifest={pendingManifest}
        onConfirm={handleRestoreConfirm}
        submitting={busy}
      />
    </div>
  );
}

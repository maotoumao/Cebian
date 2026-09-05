import { ArrowUp, ChevronRight, Folder } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { SessionLabelRow } from '@/lib/persistence/db';
import { formatBytes } from '@/lib/utils';
import { fileExtension, navigateTo, parentOf, pickFileIcon } from '../lib/path-utils';
import { formatWorkspaceEntry, formatWorkspaceBanner } from '../lib/session-labels';
import type { DirEntry } from '../types';

export function DirView({
  path,
  entries,
  workspaceLabels,
  workspaceRow,
}: {
  path: string;
  entries: DirEntry[];
  /** 当 `path` 为 `/workspaces` 时存在：把 UUID 子目录翻译成会话标签并按最后活动倒序。 */
  workspaceLabels?: Map<string, SessionLabelRow>;
  /** 当 `path` 为某个会话工作区目录且会话仍存在时存在：据此渲染顶部信息条。 */
  workspaceRow?: SessionLabelRow;
}) {
  const dirs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir).sort((a, b) => a.name.localeCompare(b.name));
  // 工作区根：按会话最后活动倒序（无标签的孤儿目录排末尾）；其余路径按名称升序。
  if (workspaceLabels) {
    dirs.sort((a, b) => {
      const ua = workspaceLabels.get(a.name)?.updatedAt ?? -1;
      const ub = workspaceLabels.get(b.name)?.updatedAt ?? -1;
      return ub - ua;
    });
  } else {
    dirs.sort((a, b) => a.name.localeCompare(b.name));
  }
  const sorted = [...dirs, ...files];
  const showUpNav = path !== '/';
  const banner = formatWorkspaceBanner(workspaceRow);

  if (sorted.length === 0 && !showUpNav) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
        <Folder size={48} strokeWidth={1} className="opacity-30" />
        <span className="text-sm">{t('common.empty.folder')}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {banner && (
        <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-accent/30 px-4 py-3">
          <span className="text-sm font-medium text-foreground truncate">{banner.title}</span>
          <span className="text-xs text-muted-foreground">{banner.createdLabel}</span>
        </div>
      )}
      <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
        {showUpNav && (
          <button
            onClick={() => navigateTo(parentOf(path))}
            className="group w-full flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors text-left"
          >
            <ArrowUp size={16} className="text-muted-foreground group-hover:text-primary transition-colors" />
            <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">..</span>
          </button>
        )}
        {sorted.map((entry) => {
          const fullPath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
          const ext = fileExtension(entry.name);
          const FileGlyph = pickFileIcon(ext);
          // 工作区根下的目录用会话标签替代裸 UUID 显示。
          const wsLabel = workspaceLabels && entry.isDir
            ? formatWorkspaceEntry(entry.name, workspaceLabels.get(entry.name))
            : null;
          const displayName = wsLabel ? wsLabel.title : entry.name;
          return (
            <button
              key={entry.name}
              onClick={() => navigateTo(fullPath)}
              className="group w-full flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors text-left"
            >
              {entry.isDir ? (
                <Folder size={18} strokeWidth={1.5} className="shrink-0 text-primary/80 group-hover:text-primary transition-colors" />
              ) : (
                <FileGlyph size={18} strokeWidth={1.5} className="shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
              )}
              <span className="flex-1 min-w-0 flex flex-col">
                <span
                  title={displayName}
                  className="text-sm truncate text-foreground/90 group-hover:text-foreground transition-colors"
                >
                  {displayName}
                </span>
                {wsLabel?.uuid && (
                  <span
                    title={wsLabel.uuid}
                    className="text-xs text-muted-foreground/50 truncate tabular-nums"
                  >
                    {wsLabel.uuid}
                  </span>
                )}
              </span>
              {wsLabel?.dateLabel && (
                <span className="shrink-0 text-xs text-muted-foreground/60 tabular-nums">
                  {wsLabel.dateLabel}
                </span>
              )}
              {!entry.isDir && (
                <span className="shrink-0 text-xs text-muted-foreground/60 tabular-nums">
                  {formatBytes(entry.size)}
                </span>
              )}
              {entry.isDir && (
                <ChevronRight size={14} className="shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

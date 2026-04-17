/**
 * FileWorkspace — shared two-column (file tree + editor) workspace used by
 * the Prompts and Skills Settings sections.
 *
 * Decoupling rules (see 2026-04-15 plan):
 * - FileWorkspace knows **nothing** about prompts / skills. It exposes a
 *   generic `toolbarActions` prop so callers (SkillsSection, etc.) can
 *   contribute domain-specific commands.
 * - Selection is URL-driven via `relativePath` + `onSelectRelative`.
 * - An imperative `FileWorkspaceHandle` lets callers run `createFile`,
 *   `refresh`, and `selectAbs` (e.g. after scaffolding a skill folder).
 */
import {
  useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef,
  Fragment, type ReactNode, type ComponentType,
} from 'react';
import { Search, FilePlus, FolderPlus, MoreHorizontal } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { FileTree, type FileTreeHandle } from '@/components/editor/FileTree';
import { EditorPanel } from '@/components/ai-config/EditorPanel';
import { useIsDark } from '@/hooks/useIsDark';
import { useStorageItem, type StorageItem } from '@/hooks/useStorageItem';
import { cn } from '@/lib/utils';

const MIN_PANEL_WIDTH = 180;
const MAX_PANEL_WIDTH = 480;

/** Encode each `/`-separated segment with encodeURIComponent so `/` stays as a separator. */
export function encodeRelPath(rel: string): string {
  return rel.split('/').map(encodeURIComponent).join('/');
}

/** A custom toolbar / context-menu action contributed by a section. */
export interface FileWorkspaceAction {
  /** Unique id (used as React key). */
  id: string;
  /** lucide-react icon component. */
  icon: ComponentType<{ className?: string }>;
  /** Label shown in tooltip + context menu. */
  label: string;
  /** Callback. Typically creates resources then calls `refresh` / `selectAbs`. */
  onSelect: () => void | Promise<void>;
  /** Render a separator before this item in the context menu. */
  separatorBefore?: boolean;
}

export interface FileWorkspaceHandle {
  /**
   * Create an empty file in the tree's current-selection parent (or root).
   * Passing `''` as `initialContent` force-creates an empty file (bypasses `newFileTemplate`).
   */
  createFile: (parentAbs?: string, initialContent?: string) => void;
  /** Create an empty folder in the tree's current-selection parent (or root). */
  createFolder: (parentAbs?: string) => void;
  /** Re-scan the VFS. */
  refresh: () => void;
  /**
   * Select a file by absolute VFS path, converting to a relative path via `onSelectRelative`.
   * Caller is responsible for calling `refresh()` first when selecting a freshly-created file
   * so the node exists in the tree before selection is applied.
   */
  selectAbs: (absPath: string) => void;
}

export interface FileWorkspaceProps {
  /** Absolute VFS root directory (e.g. `~/.cebian/prompts`). */
  root: string;
  /** Currently-selected path **relative to root**, or undefined for empty state. */
  relativePath?: string;
  /** Called when the user selects a different file. Relative path or null on clear. */
  onSelectRelative: (relativePath: string | null) => void;
  /** Called after a save; caller may use this to invalidate caches. */
  onSave?: () => void;
  /** Allow creating subfolders (false = flat file list). */
  allowNewFolder?: boolean;
  /** Initial content for files created via the toolbar "+" button. */
  newFileTemplate?: string;
  /** Enable `{{variable}}` highlighting + autocomplete in the editor. */
  enableTemplateVars?: boolean;
  /** Storage item for persisting the left-panel width. */
  panelWidthStorage: StorageItem<number>;
  /** Default left-panel width when no stored value is present. */
  defaultPanelWidth?: number;
  /** Section-contributed actions (rendered in toolbar + right-click menu). */
  toolbarActions?: FileWorkspaceAction[];
  /** Optional extra class for the root container. */
  className?: string;
  /** Optional empty-state content to render when `relativePath` is undefined. */
  emptyState?: ReactNode;
}

export const FileWorkspace = forwardRef<FileWorkspaceHandle, FileWorkspaceProps>(function FileWorkspace({
  root,
  relativePath,
  onSelectRelative,
  onSave,
  allowNewFolder = false,
  newFileTemplate = '',
  enableTemplateVars = false,
  panelWidthStorage,
  defaultPanelWidth = 280,
  toolbarActions,
  className,
  emptyState,
}, ref) {
  const isDark = useIsDark();

  const [search, setSearch] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [overflowOpen, setOverflowOpen] = useState(false);

  const [panelWidth, setPanelWidth] = useStorageItem(panelWidthStorage, defaultPanelWidth);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const latestDragWidthRef = useRef<number>(defaultPanelWidth);
  const dragListenersRef = useRef<{ move: (ev: MouseEvent) => void; up: () => void } | null>(null);

  const fileTreeRef = useRef<FileTreeHandle>(null);

  // ─── Selection / callbacks ───

  const selectedAbs = relativePath ? `${root}/${relativePath}` : null;

  const handleTreeSelect = useCallback((absPath: string) => {
    if (!absPath) { onSelectRelative(null); return; }
    const prefix = `${root}/`;
    if (!absPath.startsWith(prefix)) return;
    onSelectRelative(absPath.slice(prefix.length));
  }, [root, onSelectRelative]);

  const handleSave = useCallback(() => {
    setRefreshKey((k) => k + 1);
    onSave?.();
  }, [onSave]);

  // ─── Imperative API exposed to parent sections ───

  useImperativeHandle(ref, () => ({
    createFile: (parentAbs, initialContent) => {
      fileTreeRef.current?.createFile(parentAbs, initialContent ?? newFileTemplate);
    },
    createFolder: (parentAbs) => {
      fileTreeRef.current?.createFolder(parentAbs);
    },
    refresh: () => setRefreshKey((k) => k + 1),
    selectAbs: (absPath: string) => {
      handleTreeSelect(absPath);
    },
  }), [newFileTemplate, handleTreeSelect]);

  // ─── Drag handle ───

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startWidth = dragWidth ?? panelWidth;
    dragStartRef.current = { startX: e.clientX, startWidth };
    latestDragWidthRef.current = startWidth;
    const onMouseMove = (ev: MouseEvent) => {
      if (!dragStartRef.current) return;
      const delta = ev.clientX - dragStartRef.current.startX;
      const newWidth = Math.max(
        MIN_PANEL_WIDTH,
        Math.min(MAX_PANEL_WIDTH, dragStartRef.current.startWidth + delta),
      );
      latestDragWidthRef.current = newWidth;
      setDragWidth(newWidth);
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setPanelWidth(latestDragWidthRef.current);
      setDragWidth(null);
      dragStartRef.current = null;
      dragListenersRef.current = null;
    };
    dragListenersRef.current = { move: onMouseMove, up: onMouseUp };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [dragWidth, panelWidth, setPanelWidth]);

  // Cleanup: if component unmounts mid-drag, detach document listeners and reset body styles.
  useEffect(() => {
    return () => {
      const listeners = dragListenersRef.current;
      if (listeners) {
        document.removeEventListener('mousemove', listeners.move);
        document.removeEventListener('mouseup', listeners.up);
        dragListenersRef.current = null;
        dragStartRef.current = null;
      }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const currentWidth = dragWidth ?? panelWidth;

  // ─── Toolbar overflow rule ───
  //
  // Built-in actions (+file, optional +folder) always render. Custom
  // `toolbarActions` render inline if there are ≤ 3; once there are 4 or
  // more, the first 2 render inline and the rest collapse into a `⋯`
  // Popover. The right-click context menu never collapses.

  const customActions = toolbarActions ?? [];
  const INLINE_LIMIT = 3;
  const INLINE_KEEP = 2;
  const inlineCustom = customActions.length <= INLINE_LIMIT ? customActions : customActions.slice(0, INLINE_KEEP);
  const overflowCustom = customActions.length <= INLINE_LIMIT ? [] : customActions.slice(INLINE_KEEP);

  const runAction = useCallback(async (a: FileWorkspaceAction) => {
    setOverflowOpen(false);
    try { await a.onSelect(); } catch (err) { console.error('[FileWorkspace] action failed', a.id, err); }
  }, []);

  // ─── Render ───

  return (
    <div className={cn('flex min-h-0', className)}>
      {/* Left panel: toolbar + file tree */}
      <div
        className="shrink-0 border-r border-border flex flex-col"
        style={{ width: currentWidth }}
      >
        {/* Toolbar */}
        <div className="flex items-center gap-1 p-2.5 border-b border-border shrink-0">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索..."
              className="h-8 pl-8 text-[13px]"
            />
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => fileTreeRef.current?.createFile(undefined, newFileTemplate)}
            title="新建文件"
          >
            <FilePlus className="size-4" />
          </Button>
          {allowNewFolder && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => fileTreeRef.current?.createFolder()}
              title="新建文件夹"
            >
              <FolderPlus className="size-4" />
            </Button>
          )}
          {inlineCustom.map((a) => {
            const Icon = a.icon;
            return (
              <Button
                key={a.id}
                variant="ghost"
                size="icon-xs"
                onClick={() => runAction(a)}
                title={a.label}
              >
                <Icon className="size-4" />
              </Button>
            );
          })}
          {overflowCustom.length > 0 && (
            <Popover open={overflowOpen} onOpenChange={setOverflowOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-xs" title="更多操作">
                  <MoreHorizontal className="size-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-44 p-1">
                <div className="flex flex-col">
                  {overflowCustom.map((a) => {
                    const Icon = a.icon;
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => runAction(a)}
                        className="flex items-center gap-2 px-2 py-1.5 rounded-sm text-[13px] hover:bg-accent text-left"
                      >
                        <Icon className="size-3.5 shrink-0" />
                        <span className="truncate">{a.label}</span>
                      </button>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>

        {/* File tree with right-click on empty area */}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div className="flex-1 min-h-0">
              <FileTree
                ref={fileTreeRef}
                root={root}
                selectedFile={selectedAbs}
                onSelect={handleTreeSelect}
                refreshKey={refreshKey}
                searchTerm={search || undefined}
                allowNewFolder={allowNewFolder}
              />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => fileTreeRef.current?.createFile(undefined, newFileTemplate)}>
              <FilePlus className="size-3.5 mr-2" /> 新建文件
            </ContextMenuItem>
            {allowNewFolder && (
              <ContextMenuItem onClick={() => fileTreeRef.current?.createFolder()}>
                <FolderPlus className="size-3.5 mr-2" /> 新建文件夹
              </ContextMenuItem>
            )}
            {customActions.map((a) => {
              const Icon = a.icon;
              return (
                <Fragment key={a.id}>
                  {a.separatorBefore && <ContextMenuSeparator />}
                  <ContextMenuItem onClick={() => runAction(a)}>
                    <Icon className="size-3.5 mr-2" /> {a.label}
                  </ContextMenuItem>
                </Fragment>
              );
            })}
          </ContextMenuContent>
        </ContextMenu>
      </div>

      {/* Drag handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        className="w-1 shrink-0 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
        onMouseDown={handleDragStart}
      />

      {/* Right panel: editor */}
      <div className="flex-1 min-w-0">
        {selectedAbs ? (
          <EditorPanel
            filePath={selectedAbs}
            rootPath={root}
            isDark={isDark}
            enableTemplateVars={enableTemplateVars}
            onSave={handleSave}
          />
        ) : (
          emptyState ?? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
              从左侧选择或创建文件
            </div>
          )
        )}
      </div>
    </div>
  );
});

/**
 * AIConfigContent — shared core UI for Prompts & Skills management.
 *
 * Used by both AIConfigDialog (in dialog) and the standalone tab page.
 * Two-tab layout with unified two-column design:
 *   Left:  Toolbar + FileTree
 *   Right: EditorPanel
 *   Divider: draggable to resize
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { Search, FilePlus, FolderPlus, Blocks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { FileTree, type FileTreeHandle } from '@/components/editor/FileTree';
import { EditorPanel } from './EditorPanel';
import { useIsDark } from '@/hooks/useIsDark';
import { useStorageItem } from '@/hooks/useStorageItem';
import { CEBIAN_PROMPTS_DIR, CEBIAN_SKILLS_DIR } from '@/lib/constants';
import { cn } from '@/lib/utils';
import type { StorageItem } from '@/hooks/useStorageItem';

// ─── Types ───

type Tab = 'prompts' | 'skills';

const MIN_PANEL_WIDTH = 180;
const MAX_PANEL_WIDTH = 480;

const PROMPT_TEMPLATE = `---\nname: new-prompt\ndescription: ""\n---\n\n(Write your prompt here)\n`;

interface AIConfigContentProps {
  /** Storage item for persisting panel width (different key for dialog vs tab page). */
  panelWidthStorage: StorageItem<number>;
  /** Default panel width. */
  defaultPanelWidth?: number;
  /** Optional CSS class for the container. */
  className?: string;
}

// ─── Component ───

export function AIConfigContent({ panelWidthStorage, defaultPanelWidth = 240, className }: AIConfigContentProps) {
  const isDark = useIsDark();
  const [tab, setTab] = useState<Tab>('prompts');

  // Per-tab selection + refresh
  const [promptFile, setPromptFile] = useState('');
  const [skillFile, setSkillFile] = useState('');
  const [promptRefreshKey, setPromptRefreshKey] = useState(0);
  const [skillRefreshKey, setSkillRefreshKey] = useState(0);

  // Search
  const [search, setSearch] = useState('');

  // Resizable panel
  const [panelWidth, setPanelWidth] = useStorageItem(panelWidthStorage, defaultPanelWidth);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const latestDragWidthRef = useRef<number>(defaultPanelWidth);

  // FileTree ref for imperative create
  const fileTreeRef = useRef<FileTreeHandle>(null);

  const handleSave = useCallback(() => {
    if (tab === 'prompts') setPromptRefreshKey((k) => k + 1);
    else {
      setSkillRefreshKey((k) => k + 1);
      // Notify background to clear cached skill index
      try { chrome.runtime.sendMessage({ type: 'invalidate_skill_index' }); } catch { /* ignore */ }
    }
  }, [tab]);

  // ─── Drag handle ───

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startWidth = dragWidth ?? panelWidth;
    dragStartRef.current = { startX: e.clientX, startWidth };
    latestDragWidthRef.current = startWidth;
    const onMouseMove = (ev: MouseEvent) => {
      if (!dragStartRef.current) return;
      const delta = ev.clientX - dragStartRef.current.startX;
      const newWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, dragStartRef.current.startWidth + delta));
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
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  };

  // Cleanup body styles if component unmounts mid-drag
  useEffect(() => {
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  // ─── Tab switching resets search ───

  const switchTab = (t: Tab) => {
    setTab(t);
    setSearch('');
  };

  // ─── Derived values ───

  const isPrompts = tab === 'prompts';
  const root = isPrompts ? CEBIAN_PROMPTS_DIR : CEBIAN_SKILLS_DIR;
  const selectedFile = isPrompts ? promptFile : skillFile;
  const onSelect = isPrompts ? setPromptFile : setSkillFile;
  const refreshKey = isPrompts ? promptRefreshKey : skillRefreshKey;
  const currentWidth = dragWidth ?? panelWidth;

  return (
    <div className={cn('flex flex-col', className)}>
      {/* Tabs */}
      <div className="flex gap-1 px-5 py-3 shrink-0" role="tablist">
        {(['prompts', 'skills'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => switchTab(t)}
            className={cn(
              'px-3.5 py-1.5 rounded-md text-sm font-medium transition-colors',
              tab === t ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
            )}
          >
            {t === 'prompts' ? 'Prompts' : 'Skills'}
          </button>
        ))}
      </div>

      {/* Two-column body */}
      <div className="flex flex-1 min-h-0 border-t border-border">
        {/* Left panel: toolbar + file tree */}
        <div className="shrink-0 border-r border-border flex flex-col" style={{ width: currentWidth }}>
          {/* Toolbar */}
          <div className="flex items-center gap-1 p-2.5 border-b border-border shrink-0">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索..."
                className="h-8 pl-8 text-[13px]"
              />
            </div>
            {isPrompts ? (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => fileTreeRef.current?.createFile()}
                title="新建 Prompt"
              >
                <FilePlus className="size-4" />
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => fileTreeRef.current?.createFile()}
                  title="新建文件"
                >
                  <FilePlus className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => fileTreeRef.current?.createFolder()}
                  title="新建文件夹"
                >
                  <FolderPlus className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => fileTreeRef.current?.createSkill()}
                  title="创建 Skill"
                >
                  <Blocks className="size-4" />
                </Button>
              </>
            )}
          </div>

          {/* File tree with right-click on empty area */}
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="flex-1 min-h-0">
                <FileTree
                  ref={fileTreeRef}
                  root={root}
                  selectedFile={selectedFile}
                  onSelect={onSelect}
                  refreshKey={refreshKey}
                  searchTerm={search || undefined}
                  allowNewFolder={!isPrompts}
                  newFileTemplate={isPrompts ? PROMPT_TEMPLATE : ''}
                  createFileLabel={isPrompts ? '新建 Prompt' : '新建文件'}
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              {isPrompts ? (
                <ContextMenuItem onClick={() => fileTreeRef.current?.createFile()}>
                  <FilePlus className="size-3.5 mr-2" /> 新建 Prompt
                </ContextMenuItem>
              ) : (
                <>
                  <ContextMenuItem onClick={() => fileTreeRef.current?.createFile()}>
                    <FilePlus className="size-3.5 mr-2" /> 新建文件
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => fileTreeRef.current?.createFolder()}>
                    <FolderPlus className="size-3.5 mr-2" /> 新建文件夹
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => fileTreeRef.current?.createSkill()}>
                    <Blocks className="size-3.5 mr-2" /> 创建 Skill
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
        </div>

        {/* Drag handle */}
        <div
          className="w-1 shrink-0 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 transition-colors"
          onMouseDown={handleDragStart}
        />

        {/* Right panel: editor */}
        <div className="flex-1 min-w-0">
          <EditorPanel
            filePath={selectedFile || undefined}
            rootPath={root}
            isDark={isDark}
            enableTemplateVars={isPrompts}
            onSave={handleSave}
          />
        </div>
      </div>
    </div>
  );
}

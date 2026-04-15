/**
 * FileTree — VFS file tree powered by react-arborist.
 *
 * Features: drag & drop, inline rename/create (VS Code style), keyboard navigation,
 * virtualized rendering, file-type icons, right-click context menu.
 */
import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from 'react';
import { Tree, type NodeRendererProps, type NodeApi, type TreeApi } from 'react-arborist';
import { ChevronRight, ChevronDown, Folder, FolderOpen, FileText, FileCode, FileType, Trash2, FilePlus, FolderPlus, Pencil, Star } from 'lucide-react';
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { vfs } from '@/lib/vfs';
import { cn } from '@/lib/utils';

// ─── Types ───

interface TreeNodeData {
  id: string;       // full VFS path (or temp id for uncommitted nodes)
  name: string;     // file/folder name
  children?: TreeNodeData[];
}

export interface FileTreeHandle {
  createFile: (parentId?: string) => void;
  createFolder: (parentId?: string) => void;
}

interface FileTreeProps {
  /** VFS root directory to display. */
  root: string;
  /** Currently selected file path. */
  selectedFile: string | null;
  /** Called when a file is selected. */
  onSelect: (filePath: string) => void;
  /** Incremented to trigger re-scan. */
  refreshKey?: number;
  /** Filter tree nodes by name. */
  searchTerm?: string;
}

// ─── VFS → tree data builder ───

async function buildTreeData(dirPath: string): Promise<TreeNodeData[]> {
  const nodes: TreeNodeData[] = [];
  let entries: string[];
  try { entries = await vfs.readdir(dirPath); } catch { return nodes; }

  for (const name of entries.sort()) {
    const fullPath = `${dirPath}/${name}`;
    try {
      const stat = await vfs.stat(fullPath);
      if (stat.isDirectory()) {
        const children = await buildTreeData(fullPath);
        nodes.push({ id: fullPath, name, children });
      } else {
        nodes.push({ id: fullPath, name });
      }
    } catch { /* skip unreadable entries */ }
  }
  return nodes;
}

// ─── File icon by extension ───

function FileIcon({ name, className }: { name: string; className?: string }) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'js' || ext === 'ts' || ext === 'jsx' || ext === 'tsx') {
    return <FileCode className={className} />;
  }
  if (ext === 'md') {
    return <FileType className={className} />;
  }
  return <FileText className={className} />;
}

// ─── Custom node renderer ───

function Node({ node, style, dragHandle }: NodeRendererProps<TreeNodeData>) {
  const isSkillMd = node.data.name === 'SKILL.md';

  const content = (
    <div
      ref={dragHandle}
      style={style}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1 rounded-sm text-[13px] cursor-pointer select-none group',
        node.isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
        node.willReceiveDrop && 'bg-primary/10 ring-1 ring-primary/30',
        node.isDragging && 'opacity-40',
      )}
      onClick={(e) => node.handleClick(e)}
    >
      {/* Expand/collapse arrow for folders */}
      {node.isInternal ? (
        <span className="shrink-0 size-4 flex items-center justify-center" onClick={(e) => { e.stopPropagation(); node.toggle(); }}>
          {node.isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
      ) : (
        <span className="shrink-0 size-4" />
      )}

      {/* Icon */}
      {node.isInternal ? (
        node.isOpen
          ? <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          : <Folder className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <FileIcon name={node.data.name} className="size-4 shrink-0 text-muted-foreground" />
      )}

      {/* Name or rename input */}
      {node.isEditing ? (
        <input
          type="text"
          defaultValue={node.data.name}
          className="flex-1 min-w-0 h-[22px] text-[13px] px-1 py-0 border rounded bg-background outline-none focus:ring-1 focus:ring-primary/40"
          autoFocus
          onFocus={(e) => {
            const dotIdx = e.target.value.lastIndexOf('.');
            e.target.setSelectionRange(0, dotIdx > 0 ? dotIdx : e.target.value.length);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') node.submit((e.target as HTMLInputElement).value);
            if (e.key === 'Escape') node.reset();
          }}
          onBlur={(e) => {
            const val = e.target.value.trim();
            if (val) node.submit(val);
            else node.reset();
          }}
        />
      ) : (
        <span className="truncate flex-1">{node.data.name}</span>
      )}

      {/* SKILL.md star badge */}
      {isSkillMd && !node.isEditing && (
        <Star className="size-3 shrink-0 text-amber-500 fill-amber-500" />
      )}
    </div>
  );

  // Context menu items
  const menuItems = node.isInternal ? (
    <>
      <ContextMenuItem onClick={() => node.tree.create({ parentId: node.id, type: 'leaf' })}>
        <FilePlus className="size-3.5 mr-2" /> 新建文件
      </ContextMenuItem>
      <ContextMenuItem onClick={() => node.tree.create({ parentId: node.id, type: 'internal' })}>
        <FolderPlus className="size-3.5 mr-2" /> 新建文件夹
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => node.edit()}>
        <Pencil className="size-3.5 mr-2" /> 重命名
      </ContextMenuItem>
      <ContextMenuItem onClick={() => node.tree.delete(node.id)} className="text-destructive focus:text-destructive">
        <Trash2 className="size-3.5 mr-2" /> 删除
      </ContextMenuItem>
    </>
  ) : (
    <>
      <ContextMenuItem onClick={() => node.edit()}>
        <Pencil className="size-3.5 mr-2" /> 重命名
      </ContextMenuItem>
      <ContextMenuItem onClick={() => node.tree.delete(node.id)} className="text-destructive focus:text-destructive">
        <Trash2 className="size-3.5 mr-2" /> 删除
      </ContextMenuItem>
    </>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div onContextMenu={(e) => e.stopPropagation()}>
          {content}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menuItems}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ─── Main component ───

export const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(
  function FileTree({ root, selectedFile, onSelect, refreshKey, searchTerm }, ref) {
  const [data, setData] = useState<TreeNodeData[]>([]);
  const treeRef = useRef<TreeApi<TreeNodeData>>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 200, height: 400 });

  // Track temporary node ids created via tree.create() that haven't been committed to VFS yet
  const pendingCreatesRef = useRef<Map<string, 'leaf' | 'internal'>>(new Map());

  // Expose imperative methods so parent can trigger create from toolbar / context menu
  useImperativeHandle(ref, () => ({
    createFile: (parentId?: string) => {
      treeRef.current?.create({ parentId: parentId ?? null, type: 'leaf' });
    },
    createFolder: (parentId?: string) => {
      treeRef.current?.create({ parentId: parentId ?? null, type: 'internal' });
    },
  }), []);

  // Native ResizeObserver for dynamic sizing
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setDims({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scan = useCallback(async () => {
    setData(await buildTreeData(root));
  }, [root]);

  useEffect(() => { scan(); }, [scan, refreshKey]);

  // ─── Data handlers (controlled mode) ───

  // onCreate: return a temp node so react-arborist shows an inline input.
  // The actual VFS write happens in onRename when the user confirms the name.
  const onCreate = ({ parentId, type }: { parentId: string | null; index: number; type: 'internal' | 'leaf' }) => {
    const parent = parentId ?? root;
    const tempId = `${parent}/__new_${Date.now()}`;
    pendingCreatesRef.current.set(tempId, type);
    return { id: tempId, name: '', children: type === 'internal' ? [] : undefined };
  };

  const onRename = async ({ id, name }: { id: string; name: string }) => {
    const trimmed = name.trim();

    // ─── Handle pending create (new file/folder) ───
    const pendingType = pendingCreatesRef.current.get(id);
    if (pendingType !== undefined) {
      pendingCreatesRef.current.delete(id);

      // Empty name or Escape → cancel creation
      if (!trimmed) {
        await scan();
        return;
      }

      const parentDir = id.substring(0, id.lastIndexOf('/'));
      const newPath = `${parentDir}/${trimmed}`;

      try {
        if (pendingType === 'internal') {
          await vfs.mkdir(newPath, { recursive: true });
        } else {
          await vfs.writeFile(newPath, '');
          onSelect(newPath);
        }
      } catch { /* ignore */ }
      await scan();
      return;
    }

    // ─── Handle regular rename ───
    if (!trimmed) return;
    const parentDir = id.substring(0, id.lastIndexOf('/'));
    const newPath = `${parentDir}/${trimmed}`;
    if (newPath === id) return;
    try {
      await vfs.rename(id, newPath);
      await scan();
      if (selectedFile === id) onSelect(newPath);
      else if (selectedFile?.startsWith(id + '/')) onSelect(selectedFile.replace(id, newPath));
    } catch { /* ignore rename errors (e.g. collision) */ }
  };

  const onMove = async ({ dragIds, parentId }: { dragIds: string[]; parentId: string | null; index: number }) => {
    const target = parentId ?? root;
    for (const srcPath of dragIds) {
      const name = srcPath.substring(srcPath.lastIndexOf('/') + 1);
      const destPath = `${target}/${name}`;
      if (destPath === srcPath) continue;
      try {
        await vfs.rename(srcPath, destPath);
        if (selectedFile === srcPath) onSelect(destPath);
        else if (selectedFile?.startsWith(srcPath + '/')) onSelect(selectedFile.replace(srcPath, destPath));
      } catch { /* ignore */ }
    }
    await scan();
  };

  const onDelete = async ({ ids }: { ids: string[] }) => {
    // Filter out any pending temp nodes
    const realIds = ids.filter((id) => !pendingCreatesRef.current.has(id));
    for (const path of realIds) {
      try {
        const stat = await vfs.stat(path);
        if (stat.isDirectory()) await vfs.rm(path, { recursive: true, force: true });
        else await vfs.unlink(path);
      } catch { /* ignore */ }
    }
    // Clean up any pending temp nodes
    for (const id of ids) pendingCreatesRef.current.delete(id);
    await scan();
    if (selectedFile && realIds.some((id) => selectedFile === id || selectedFile.startsWith(id + '/'))) {
      onSelect('');
    }
  };

  const onActivate = (node: NodeApi<TreeNodeData>) => {
    if (node.isLeaf) onSelect(node.id);
  };

  return (
    <div ref={containerRef} className="h-full w-full relative">
      <Tree<TreeNodeData>
        ref={treeRef}
        data={data}
        onCreate={onCreate}
        onRename={onRename}
        onMove={onMove}
        onDelete={onDelete}
        onActivate={onActivate}
        selection={selectedFile ?? undefined}
        openByDefault={true}
        disableMultiSelection
        searchTerm={searchTerm}
        searchMatch={(node, term) => node.data.name.toLowerCase().includes(term.toLowerCase())}
        width={dims.width}
        height={dims.height}
        indent={16}
        rowHeight={30}
        paddingTop={6}
        paddingBottom={6}
      >
        {Node}
      </Tree>
      {data.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground pointer-events-none">
          空文件夹
        </div>
      )}
    </div>
  );
});

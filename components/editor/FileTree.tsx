/**
 * FileTree — VFS file tree powered by react-arborist.
 *
 * Features: drag & drop, inline rename, keyboard navigation,
 * virtualized rendering, file-type icons, right-click context menu.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Tree, type NodeRendererProps, type NodeApi, type TreeApi } from 'react-arborist';
import { ChevronRight, ChevronDown, Folder, FolderOpen, FileText, FileCode, FileType, Trash2, FilePlus, FolderPlus, Pencil, Star } from 'lucide-react';
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { vfs } from '@/lib/vfs';
import { cn } from '@/lib/utils';

// ─── Types ───

interface TreeNodeData {
  id: string;       // full VFS path
  name: string;     // file/folder name
  children?: TreeNodeData[];
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
        'flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-xs cursor-pointer select-none group',
        node.isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
        node.willReceiveDrop && 'bg-primary/10 ring-1 ring-primary/30',
        node.isDragging && 'opacity-40',
      )}
      onClick={(e) => node.handleClick(e)}
    >
      {/* Expand/collapse arrow for folders */}
      {node.isInternal ? (
        <span className="shrink-0 size-3.5 flex items-center justify-center" onClick={(e) => { e.stopPropagation(); node.toggle(); }}>
          {node.isOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </span>
      ) : (
        <span className="shrink-0 size-3.5" />
      )}

      {/* Icon */}
      {node.isInternal ? (
        node.isOpen
          ? <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
          : <Folder className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <FileIcon name={node.data.name} className="size-3.5 shrink-0 text-muted-foreground" />
      )}

      {/* Name or rename input */}
      {node.isEditing ? (
        <input
          type="text"
          defaultValue={node.data.name}
          className="flex-1 min-w-0 h-5 text-xs px-1 py-0 border rounded bg-background outline-none"
          autoFocus
          onFocus={(e) => {
            const dotIdx = e.target.value.lastIndexOf('.');
            e.target.setSelectionRange(0, dotIdx > 0 ? dotIdx : e.target.value.length);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') node.submit((e.target as HTMLInputElement).value);
            if (e.key === 'Escape') node.reset();
          }}
          onBlur={(e) => node.submit(e.target.value)}
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
        <FilePlus className="size-3.5" /> 新建文件
      </ContextMenuItem>
      <ContextMenuItem onClick={() => node.tree.create({ parentId: node.id, type: 'internal' })}>
        <FolderPlus className="size-3.5" /> 新建文件夹
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => node.edit()}>
        <Pencil className="size-3.5" /> 重命名
      </ContextMenuItem>
      <ContextMenuItem onClick={() => node.tree.delete(node.id)} className="text-destructive focus:text-destructive">
        <Trash2 className="size-3.5" /> 删除
      </ContextMenuItem>
    </>
  ) : (
    <>
      <ContextMenuItem onClick={() => node.edit()}>
        <Pencil className="size-3.5" /> 重命名
      </ContextMenuItem>
      <ContextMenuItem onClick={() => node.tree.delete(node.id)} className="text-destructive focus:text-destructive">
        <Trash2 className="size-3.5" /> 删除
      </ContextMenuItem>
    </>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {content}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {menuItems}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ─── Main component ───

export function FileTree({ root, selectedFile, onSelect, refreshKey }: FileTreeProps) {
  const [data, setData] = useState<TreeNodeData[]>([]);
  const treeRef = useRef<TreeApi<TreeNodeData>>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 200, height: 400 });

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

  const onCreate = async ({ parentId, type }: { parentId: string | null; index: number; type: 'internal' | 'leaf' }) => {
    const parent = parentId ?? root;
    if (type === 'internal') {
      let name = 'new-folder';
      let n = 1;
      while (await vfs.exists(`${parent}/${name}`)) name = `new-folder-${n++}`;
      await vfs.mkdir(`${parent}/${name}`, { recursive: true });
      await scan();
      return { id: `${parent}/${name}`, name };
    } else {
      let name = 'new-file.md';
      let n = 1;
      while (await vfs.exists(`${parent}/${name}`)) name = `new-file-${n++}.md`;
      await vfs.writeFile(`${parent}/${name}`, '');
      await scan();
      onSelect(`${parent}/${name}`);
      return { id: `${parent}/${name}`, name };
    }
  };

  const onRename = async ({ id, name }: { id: string; name: string }) => {
    const trimmed = name.trim();
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
    for (const path of ids) {
      try {
        const stat = await vfs.stat(path);
        if (stat.isDirectory()) await vfs.rm(path, { recursive: true, force: true });
        else await vfs.unlink(path);
      } catch { /* ignore */ }
    }
    await scan();
    if (selectedFile && ids.some((id) => selectedFile === id || selectedFile.startsWith(id + '/'))) {
      onSelect('');
    }
  };

  const onActivate = (node: NodeApi<TreeNodeData>) => {
    if (node.isLeaf) onSelect(node.id);
  };

  return (
    <div ref={containerRef} className="h-full w-full">
      {data.length === 0 ? (
        <div className="h-full flex items-center justify-center text-xs text-muted-foreground py-4">
          空文件夹
        </div>
      ) : (
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
        width={dims.width}
        height={dims.height}
        indent={14}
        rowHeight={26}
        paddingTop={4}
        paddingBottom={4}
      >
        {Node}
      </Tree>
      )}
    </div>
  );
}

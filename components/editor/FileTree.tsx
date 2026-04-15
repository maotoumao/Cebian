/**
 * FileTree — generic recursive file tree for a VFS directory.
 *
 * Supports expand/collapse, selection, and right-click context menu
 * (new file, new folder, rename, delete).
 */
import { useState, useEffect, useCallback } from 'react';
import { ChevronRight, ChevronDown, Folder, FileText, Trash2, FilePlus, FolderPlus, Pencil } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import {
  ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { vfs } from '@/lib/vfs';
import { cn } from '@/lib/utils';

// ─── Types ───

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[];
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

// ─── Async tree builder ───

async function buildTree(dirPath: string): Promise<TreeNode[]> {
  const nodes: TreeNode[] = [];
  let entries: string[];
  try { entries = await vfs.readdir(dirPath); } catch { return nodes; }

  for (const name of entries.sort()) {
    const fullPath = `${dirPath}/${name}`;
    try {
      const stat = await vfs.stat(fullPath);
      if (stat.isDirectory()) {
        const children = await buildTree(fullPath);
        nodes.push({ name, path: fullPath, isDir: true, children });
      } else {
        nodes.push({ name, path: fullPath, isDir: false });
      }
    } catch { /* skip */ }
  }
  return nodes;
}

// ─── Inline rename input ───

function InlineRenameInput({ defaultValue, onSubmit, onCancel }: {
  defaultValue: string; onSubmit: (name: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <Input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && value.trim()) onSubmit(value.trim());
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={() => onCancel()}
      className="h-5 text-xs px-1 py-0 w-full"
      autoFocus
    />
  );
}

// ─── Tree node component ───

function TreeItem({
  node, depth, selectedFile, onSelect, onAction,
  renamingPath, setRenamingPath,
}: {
  node: TreeNode; depth: number;
  selectedFile: string | null;
  onSelect: (path: string) => void;
  onAction: (action: 'new-file' | 'new-folder' | 'rename' | 'delete', path: string, isDir: boolean, newName?: string) => void;
  renamingPath: string | null;
  setRenamingPath: (path: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const isRenaming = renamingPath === node.path;
  const paddingLeft = `${depth * 14 + 6}px`;

  const handleRenameSubmit = (newName: string) => {
    onAction('rename', node.path, node.isDir, newName);
    setRenamingPath(null);
  };

  const content = (
    <button
      onClick={() => node.isDir ? setExpanded(!expanded) : onSelect(node.path)}
      aria-expanded={node.isDir ? expanded : undefined}
      className={cn(
        'w-full flex items-center gap-1 px-1.5 py-1 rounded-sm text-left transition-colors text-xs',
        !node.isDir && selectedFile === node.path ? 'bg-accent' : 'hover:bg-accent/50',
      )}
      style={{ paddingLeft }}
    >
      {node.isDir ? (
        expanded ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />
      ) : (
        <span className="size-3 shrink-0" />
      )}
      {node.isDir
        ? <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        : <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      }
      {isRenaming ? (
        <InlineRenameInput
          defaultValue={node.name}
          onSubmit={handleRenameSubmit}
          onCancel={() => setRenamingPath(null)}
        />
      ) : (
        <span className="truncate flex-1">{node.name}</span>
      )}
    </button>
  );

  const menuItems = node.isDir ? (
    <>
      <ContextMenuItem onClick={() => onAction('new-file', node.path, true)}>
        <FilePlus className="size-3.5" /> 新建文件
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onAction('new-folder', node.path, true)}>
        <FolderPlus className="size-3.5" /> 新建文件夹
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onClick={() => setRenamingPath(node.path)}>
        <Pencil className="size-3.5" /> 重命名
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onAction('delete', node.path, true)} className="text-destructive focus:text-destructive">
        <Trash2 className="size-3.5" /> 删除
      </ContextMenuItem>
    </>
  ) : (
    <>
      <ContextMenuItem onClick={() => setRenamingPath(node.path)}>
        <Pencil className="size-3.5" /> 重命名
      </ContextMenuItem>
      <ContextMenuItem onClick={() => onAction('delete', node.path, false)} className="text-destructive focus:text-destructive">
        <Trash2 className="size-3.5" /> 删除
      </ContextMenuItem>
    </>
  );

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {content}
        </ContextMenuTrigger>
        <ContextMenuContent>
          {menuItems}
        </ContextMenuContent>
      </ContextMenu>
      {node.isDir && expanded && node.children?.map((child) => (
        <TreeItem
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedFile={selectedFile}
          onSelect={onSelect}
          onAction={onAction}
          renamingPath={renamingPath}
          setRenamingPath={setRenamingPath}
        />
      ))}
    </div>
  );
}

// ─── Main component ───

export function FileTree({ root, selectedFile, onSelect, refreshKey }: FileTreeProps) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setTree(await buildTree(root));
  }, [root]);

  useEffect(() => { scan(); }, [scan, refreshKey]);

  const handleAction = async (
    action: 'new-file' | 'new-folder' | 'rename' | 'delete',
    path: string,
    isDir: boolean,
    newName?: string,
  ) => {
    try {
      switch (action) {
        case 'new-file': {
          let fileName = 'new-file.md';
          let n = 1;
          while (await vfs.exists(`${path}/${fileName}`)) fileName = `new-file-${n++}.md`;
          await vfs.writeFile(`${path}/${fileName}`, '');
          await scan();
          onSelect(`${path}/${fileName}`);
          break;
        }
        case 'new-folder': {
          let folderName = 'new-folder';
          let n = 1;
          while (await vfs.exists(`${path}/${folderName}`)) folderName = `new-folder-${n++}`;
          await vfs.mkdir(`${path}/${folderName}`, { recursive: true });
          await scan();
          break;
        }
        case 'rename': {
          if (!newName) break;
          const parentDir = path.substring(0, path.lastIndexOf('/'));
          const newPath = `${parentDir}/${newName}`;
          await vfs.rename(path, newPath);
          await scan();
          if (selectedFile === path) onSelect(newPath);
          else if (selectedFile?.startsWith(path + '/')) onSelect(selectedFile.replace(path, newPath));
          break;
        }
        case 'delete': {
          if (isDir) await vfs.rm(path, { recursive: true, force: true });
          else await vfs.unlink(path);
          await scan();
          if (selectedFile === path || (isDir && selectedFile?.startsWith(path + '/'))) onSelect('');
          break;
        }
      }
    } catch { /* ignore */ }
  };

  if (tree.length === 0) {
    return (
      <div className="flex items-center justify-center text-xs text-muted-foreground py-4">
        空文件夹
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="py-1">
        {tree.map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            selectedFile={selectedFile}
            onSelect={onSelect}
            onAction={handleAction}
            renamingPath={renamingPath}
            setRenamingPath={setRenamingPath}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

/**
 * PromptList — file list panel for the Prompts tab.
 *
 * Displays all .md files from ~/.cebian/prompts/ with search and CRUD.
 */
import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, FileText, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { vfs } from '@/lib/vfs';
import { CEBIAN_PROMPTS_DIR } from '@/lib/constants';
import { parseFrontmatter } from '@/lib/ai-config/frontmatter';
import { cn } from '@/lib/utils';

interface PromptEntry {
  fileName: string;
  name: string;
  description: string;
}

interface PromptListProps {
  selectedFile: string | null;
  onSelect: (fileName: string) => void;
  /** Incremented externally to trigger a re-scan (e.g. after save). */
  refreshKey?: number;
}

export function PromptList({ selectedFile, onSelect, refreshKey }: PromptListProps) {
  const [entries, setEntries] = useState<PromptEntry[]>([]);
  const [search, setSearch] = useState('');

  const scan = useCallback(async () => {
    const results: PromptEntry[] = [];
    try {
      const files = await vfs.readdir(CEBIAN_PROMPTS_DIR);
      for (const f of files) {
        if (!f.endsWith('.md')) continue;
        try {
          const raw = await vfs.readFile(`${CEBIAN_PROMPTS_DIR}/${f}`, 'utf8');
          const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
          const { data } = parseFrontmatter(content);
          results.push({
            fileName: f,
            name: typeof data.name === 'string' ? data.name : f.replace(/\.md$/, ''),
            description: typeof data.description === 'string' ? data.description : '',
          });
        } catch { /* skip */ }
      }
    } catch { /* dir may not exist */ }
    setEntries(results);
  }, []);

  useEffect(() => { scan(); }, [scan, refreshKey]);

  const handleNew = async () => {
    try {
      const template = `---\nname: new-prompt\ndescription: ""\n---\n\n`;
      let fileName = 'new-prompt.md';
      let n = 1;
      while (entries.some((e) => e.fileName === fileName)) {
        fileName = `new-prompt-${n++}.md`;
      }
      await vfs.writeFile(`${CEBIAN_PROMPTS_DIR}/${fileName}`, template);
      await scan();
      onSelect(fileName);
    } catch { /* ignore */ }
  };

  const handleDelete = async (e: React.MouseEvent, fileName: string) => {
    e.stopPropagation();
    try {
      await vfs.unlink(`${CEBIAN_PROMPTS_DIR}/${fileName}`);
      await scan();
      if (selectedFile === fileName) onSelect('');
    } catch { /* ignore */ }
  };

  const filtered = search
    ? entries.filter((e) => e.name.toLowerCase().includes(search.toLowerCase()) || e.description.toLowerCase().includes(search.toLowerCase()))
    : entries;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 p-2 border-b border-border">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索..."
            className="h-7 pl-7 text-xs"
          />
        </div>
        <Button variant="ghost" size="icon-xs" onClick={handleNew} title="新建 Prompt">
          <Plus className="size-4" />
        </Button>
      </div>

      {/* List */}
      <ScrollArea className="flex-1">
        <div className="p-1">
          {filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">
              {entries.length === 0 ? '暂无 Prompt' : '无匹配结果'}
            </p>
          ) : (
            filtered.map((entry) => (
              <button
                key={entry.fileName}
                onClick={() => onSelect(entry.fileName)}
                className={cn(
                  'w-full flex items-start gap-2 px-2.5 py-2 rounded-md text-left transition-colors group',
                  selectedFile === entry.fileName ? 'bg-accent' : 'hover:bg-accent/50',
                )}
              >
                <FileText className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{entry.name}</p>
                  {entry.description && (
                    <p className="text-xs text-muted-foreground truncate">{entry.description}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="opacity-0 group-hover:opacity-100 shrink-0"
                  onClick={(e) => handleDelete(e, entry.fileName)}
                  title="删除"
                >
                  <Trash2 className="size-3.5 text-destructive" />
                </Button>
              </button>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

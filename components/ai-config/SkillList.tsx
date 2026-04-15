/**
 * SkillList — simple list of skill folders under ~/.cebian/skills/.
 *
 * Each skill is a top-level directory. Selecting one passes its path
 * to the parent, which gives it to EditorPanel as a workspace.
 */
import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Folder, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { vfs } from '@/lib/vfs';
import { CEBIAN_SKILLS_DIR, SKILL_ENTRY_FILE } from '@/lib/constants';
import { validateSkillName } from '@/lib/ai-config/skill-validator';
import { cn } from '@/lib/utils';

interface SkillEntry {
  name: string;
  path: string;  // full VFS path to the skill directory
}

interface SkillListProps {
  selectedSkill: string | null;
  onSelect: (skillPath: string) => void;
  refreshKey?: number;
}

export function SkillList({ selectedSkill, onSelect, refreshKey }: SkillListProps) {
  const [entries, setEntries] = useState<SkillEntry[]>([]);
  const [search, setSearch] = useState('');
  const [newSkillName, setNewSkillName] = useState('');
  const [showNewInput, setShowNewInput] = useState(false);

  const scan = useCallback(async () => {
    const results: SkillEntry[] = [];
    try {
      const dirs = await vfs.readdir(CEBIAN_SKILLS_DIR);
      for (const name of dirs.sort()) {
        const path = `${CEBIAN_SKILLS_DIR}/${name}`;
        try {
          const stat = await vfs.stat(path);
          if (stat.isDirectory()) results.push({ name, path });
        } catch { /* skip */ }
      }
    } catch { /* dir may not exist */ }
    setEntries(results);
  }, []);

  useEffect(() => { scan(); }, [scan, refreshKey]);

  const handleNewSkill = async () => {
    const name = newSkillName.trim();
    if (!validateSkillName(name).valid) return;
    try {
      const dirPath = `${CEBIAN_SKILLS_DIR}/${name}`;
      const template = `---\nname: ${name}\ndescription: "TODO — describe what this skill does and when to use it."\nmetadata:\n  matched-url: "*"\n---\n\n## Instructions\n\n(Write your skill instructions here)\n`;
      await vfs.mkdir(dirPath, { recursive: true });
      await vfs.writeFile(`${dirPath}/${SKILL_ENTRY_FILE}`, template);
      setNewSkillName('');
      setShowNewInput(false);
      await scan();
      onSelect(dirPath);
    } catch { /* ignore */ }
  };

  const handleDelete = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    try {
      await vfs.rm(path, { recursive: true, force: true });
      await scan();
      if (selectedSkill === path) onSelect('');
    } catch { /* ignore */ }
  };

  const filtered = search
    ? entries.filter((e) => e.name.toLowerCase().includes(search.toLowerCase()))
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
        <Button variant="ghost" size="icon-xs" onClick={() => setShowNewInput(!showNewInput)} title="新建 Skill">
          <Plus className="size-4" />
        </Button>
      </div>

      {/* New skill input */}
      {showNewInput && (
        <div className="flex items-center gap-1.5 p-2 border-b border-border bg-muted/30">
          <Input
            value={newSkillName}
            onChange={(e) => setNewSkillName(e.target.value)}
            placeholder="skill-name"
            className="h-7 text-xs font-mono"
            onKeyDown={(e) => { if (e.key === 'Enter') handleNewSkill(); if (e.key === 'Escape') setShowNewInput(false); }}
            autoFocus
          />
          <Button size="sm" className="h-7 text-xs" onClick={handleNewSkill} disabled={!validateSkillName(newSkillName.trim()).valid}>
            创建
          </Button>
        </div>
      )}

      {/* List */}
      <ScrollArea className="flex-1">
        <div className="p-1">
          {filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">
              {entries.length === 0 ? '暂无 Skill' : '无匹配结果'}
            </p>
          ) : (
            filtered.map((entry) => (
              <button
                key={entry.path}
                onClick={() => onSelect(entry.path)}
                className={cn(
                  'w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-left transition-colors group',
                  selectedSkill === entry.path ? 'bg-accent' : 'hover:bg-accent/50',
                )}
              >
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-sm font-medium truncate flex-1">{entry.name}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="opacity-0 group-hover:opacity-100 shrink-0"
                  onClick={(e) => handleDelete(e, entry.path)}
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

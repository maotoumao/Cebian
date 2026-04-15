/**
 * AIConfigDialog — main dialog for managing Prompts and Skills.
 *
 * Two-tab layout (Prompts / Skills), each with a unified two-column design:
 *   Left:  FileTree (rooted at the relevant VFS directory) + toolbar
 *   Right: EditorPanel (pure file editor)
 *
 * Registered in the dialog system as 'ai-config'.
 */
import { useState, useCallback } from 'react';
import { Plus, Search } from 'lucide-react';
import { DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FileTree } from '@/components/editor/FileTree';
import { EditorPanel } from './EditorPanel';
import { useIsDark } from '@/hooks/useIsDark';
import { CEBIAN_PROMPTS_DIR, CEBIAN_SKILLS_DIR, SKILL_ENTRY_FILE } from '@/lib/constants';
import { validateSkillName } from '@/lib/ai-config/skill-validator';
import { vfs } from '@/lib/vfs';
import { cn } from '@/lib/utils';

// ─── Types ───

type Tab = 'prompts' | 'skills';

// ─── Component ───

export function AIConfigDialog() {
  const isDark = useIsDark();
  const [tab, setTab] = useState<Tab>('prompts');

  // Per-tab selection + refresh
  const [promptFile, setPromptFile] = useState('');
  const [skillFile, setSkillFile] = useState('');
  const [promptRefreshKey, setPromptRefreshKey] = useState(0);
  const [skillRefreshKey, setSkillRefreshKey] = useState(0);

  // Search
  const [search, setSearch] = useState('');

  // New skill input
  const [showNewSkillInput, setShowNewSkillInput] = useState(false);
  const [newSkillName, setNewSkillName] = useState('');
  const [newSkillError, setNewSkillError] = useState('');

  const handleSave = useCallback(() => {
    if (tab === 'prompts') setPromptRefreshKey((k) => k + 1);
    else setSkillRefreshKey((k) => k + 1);
  }, [tab]);

  // ─── New prompt ───

  const handleNewPrompt = async () => {
    try {
      const template = `---\nname: new-prompt\ndescription: ""\n---\n\n`;
      let fileName = 'new-prompt.md';
      let n = 1;
      while (await vfs.exists(`${CEBIAN_PROMPTS_DIR}/${fileName}`)) fileName = `new-prompt-${n++}.md`;
      await vfs.writeFile(`${CEBIAN_PROMPTS_DIR}/${fileName}`, template);
      setPromptRefreshKey((k) => k + 1);
      setPromptFile(`${CEBIAN_PROMPTS_DIR}/${fileName}`);
    } catch { /* ignore — VFS write failure */ }
  };

  // ─── New skill ───

  const handleNewSkillSubmit = async () => {
    const name = newSkillName.trim();
    const result = validateSkillName(name);
    if (!result.valid) { setNewSkillError(result.error ?? ''); return; }

    const dirPath = `${CEBIAN_SKILLS_DIR}/${name}`;
    if (await vfs.exists(dirPath)) { setNewSkillError('该名称已存在'); return; }

    const template = `---\nname: ${name}\ndescription: "TODO — describe what this skill does and when to use it."\nmetadata:\n  matched-url: "*"\n---\n\n## Instructions\n\n(Write your skill instructions here)\n`;
    try {
      await vfs.mkdir(dirPath, { recursive: true });
      await vfs.writeFile(`${dirPath}/${SKILL_ENTRY_FILE}`, template);
    } catch { return; }
    setNewSkillName('');
    setShowNewSkillInput(false);
    setNewSkillError('');
    setSkillRefreshKey((k) => k + 1);
    setSkillFile(`${dirPath}/${SKILL_ENTRY_FILE}`);
  };

  // ─── Tab switching resets search ───

  const switchTab = (t: Tab) => {
    setTab(t);
    setSearch('');
    setShowNewSkillInput(false);
  };

  // ─── Derived values ───

  const isPrompts = tab === 'prompts';
  const root = isPrompts ? CEBIAN_PROMPTS_DIR : CEBIAN_SKILLS_DIR;
  const selectedFile = isPrompts ? promptFile : skillFile;
  const onSelect = isPrompts ? setPromptFile : setSkillFile;
  const refreshKey = isPrompts ? promptRefreshKey : skillRefreshKey;

  return (
    <div className="flex flex-col h-[85vh]">
      <DialogHeader className="shrink-0 px-4 pt-4 pb-2">
        <DialogTitle>AI 配置</DialogTitle>
      </DialogHeader>

      {/* Tabs */}
      <div className="flex gap-1 px-4 pb-2 shrink-0" role="tablist">
        {(['prompts', 'skills'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => switchTab(t)}
            className={cn(
              'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
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
        <div className="w-52 shrink-0 border-r border-border flex flex-col">
          {/* Toolbar */}
          <div className="flex items-center gap-1.5 p-2 border-b border-border shrink-0">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索..."
                className="h-7 pl-7 text-xs"
              />
            </div>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={isPrompts ? handleNewPrompt : () => setShowNewSkillInput(true)}
              title={isPrompts ? '新建 Prompt' : '新建 Skill'}
            >
              <Plus className="size-4" />
            </Button>
          </div>

          {/* New skill inline input */}
          {!isPrompts && showNewSkillInput && (
            <div className="p-2 border-b border-border shrink-0">
              <Input
                value={newSkillName}
                onChange={(e) => { setNewSkillName(e.target.value); setNewSkillError(''); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleNewSkillSubmit();
                  if (e.key === 'Escape') { setShowNewSkillInput(false); setNewSkillName(''); setNewSkillError(''); }
                }}
                placeholder="skill-name"
                className="h-7 text-xs"
                autoFocus
              />
              {newSkillError && <p className="text-xs text-destructive mt-1">{newSkillError}</p>}
            </div>
          )}

          {/* File tree */}
          <div className="flex-1 min-h-0">
            <FileTree
              root={root}
              selectedFile={selectedFile}
              onSelect={onSelect}
              refreshKey={refreshKey}
              searchTerm={search || undefined}
            />
          </div>
        </div>

        {/* Right panel: editor */}
        <div className="flex-1 min-w-0">
          <EditorPanel
            filePath={selectedFile || undefined}
            isDark={isDark}
            enableTemplateVars={isPrompts}
            onSave={handleSave}
          />
        </div>
      </div>
    </div>
  );
}

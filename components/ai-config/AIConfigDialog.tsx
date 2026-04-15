/**
 * AIConfigDialog — main dialog for managing Prompts and Skills.
 *
 * Two-tab layout (Prompts / Skills) with a list panel + editor panel.
 * For Skills, EditorPanel gets a `workspace` prop to show an embedded file tree.
 * Registered in the dialog system as 'ai-config'.
 */
import { useState, useCallback } from 'react';
import { DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PromptList } from './PromptList';
import { SkillList } from './SkillList';
import { EditorPanel } from './EditorPanel';
import { useIsDark } from '@/hooks/useIsDark';
import { CEBIAN_PROMPTS_DIR } from '@/lib/constants';
import { cn } from '@/lib/utils';

// ─── Types ───

type Tab = 'prompts' | 'skills';

// ─── Component ───

export function AIConfigDialog() {
  const isDark = useIsDark();
  const [tab, setTab] = useState<Tab>('prompts');
  const [promptFile, setPromptFile] = useState('');
  const [skillWorkspace, setSkillWorkspace] = useState('');
  const [promptRefreshKey, setPromptRefreshKey] = useState(0);
  const [skillRefreshKey, setSkillRefreshKey] = useState(0);

  const handlePromptSelect = useCallback((fileName: string) => {
    setPromptFile(fileName ? `${CEBIAN_PROMPTS_DIR}/${fileName}` : '');
  }, []);

  const handlePromptSave = useCallback(() => {
    setPromptRefreshKey((k) => k + 1);
  }, []);

  const handleSkillSave = useCallback(() => {
    setSkillRefreshKey((k) => k + 1);
  }, []);

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
            onClick={() => setTab(t)}
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
        {/* Left panel */}
        <div className="w-48 shrink-0 border-r border-border">
          {tab === 'prompts' ? (
            <PromptList
              selectedFile={promptFile ? promptFile.substring(promptFile.lastIndexOf('/') + 1) : ''}
              onSelect={handlePromptSelect}
              refreshKey={promptRefreshKey}
            />
          ) : (
            <SkillList
              selectedSkill={skillWorkspace}
              onSelect={setSkillWorkspace}
              refreshKey={skillRefreshKey}
            />
          )}
        </div>

        {/* Right panel */}
        <div className="flex-1 min-w-0">
          {tab === 'prompts' ? (
            <EditorPanel
              filePath={promptFile}
              isDark={isDark}
              enableTemplateVars
              onSave={handlePromptSave}
            />
          ) : (
            <EditorPanel
              workspace={skillWorkspace || undefined}
              isDark={isDark}
              onSave={handleSkillSave}
            />
          )}
        </div>
      </div>
    </div>
  );
}

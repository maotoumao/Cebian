import { useCallback, useMemo, useRef } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { Blocks } from 'lucide-react';
import {
  FileWorkspace, encodeRelPath,
  type FileWorkspaceAction, type FileWorkspaceHandle,
} from './FileWorkspace';
import { CEBIAN_SKILLS_DIR } from '@/lib/constants';
import { aiConfigPagePanelWidth } from '@/lib/storage';
import { createSkillTemplate } from '@/lib/ai-config/skill-creator';
import type { SettingsOutletContext } from '@/components/settings/SettingsLayout';

/**
 * SkillsSection — multi-file agent skill manager under /settings/skills[/*].
 *
 * Supports nested paths (e.g. `my-skill/scripts/foo.js`). On save, notifies
 * the background service worker to clear its cached skill index.
 *
 * Contributes a "创建 Skill" action via `toolbarActions`; the domain
 * scaffolding lives in `lib/ai-config/skill-creator.ts` so `FileWorkspace`
 * stays free of any business concepts.
 */
export function SkillsSection() {
  const { basePath, breakpoint } = useOutletContext<SettingsOutletContext>();
  const params = useParams();
  const navigate = useNavigate();
  const workspaceRef = useRef<FileWorkspaceHandle>(null);

  const splat = params['*'] ?? '';
  const relativePath = splat || undefined;

  const handleSelect = useCallback((rel: string | null) => {
    if (rel) {
      navigate(`${basePath}/skills/${encodeRelPath(rel)}`, { replace: true });
    } else {
      navigate(`${basePath}/skills`, { replace: true });
    }
  }, [basePath, navigate]);

  const handleSave = useCallback(() => {
    // Background caches the skill index; invalidate it so next agent turn re-reads.
    try { chrome.runtime.sendMessage({ type: 'invalidate_skill_index' }); } catch { /* ignore */ }
  }, []);

  const handleCreateSkill = useCallback(async () => {
    const { entryFile } = await createSkillTemplate(CEBIAN_SKILLS_DIR);
    workspaceRef.current?.refresh();
    workspaceRef.current?.selectAbs(entryFile);
  }, []);

  const toolbarActions = useMemo<FileWorkspaceAction[]>(() => [
    {
      id: 'new-skill',
      icon: Blocks,
      label: '创建 Skill',
      separatorBefore: true,
      onSelect: handleCreateSkill,
    },
  ], [handleCreateSkill]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-6 pt-6 pb-4 shrink-0 border-b border-border">
        <h2 className="text-base font-semibold">Skills</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          遵循 agentskills.io 规范的多文件技能包，agent 会按需加载。
        </p>
      </div>
      <FileWorkspace
        ref={workspaceRef}
        root={CEBIAN_SKILLS_DIR}
        relativePath={relativePath}
        onSelectRelative={handleSelect}
        onSave={handleSave}
        allowNewFolder
        panelWidthStorage={aiConfigPagePanelWidth}
        compactMode={breakpoint === 'compact'}
        className="flex-1"
        toolbarActions={toolbarActions}
      />
    </div>
  );
}

import { useCallback } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { FileWorkspace, encodeRelPath } from './FileWorkspace';
import { CEBIAN_PROMPTS_DIR } from '@/lib/constants';
import { settingsFilePanelWidth } from '@/lib/storage';
import type { SettingsOutletContext } from '@/components/settings/SettingsLayout';
import { t } from '@/lib/i18n';

const PROMPT_TEMPLATE = () => `---
name: new-prompt
description: ""
---

${t('settings.prompts.newBody')}
`;

/**
 * PromptsSection — reusable prompt template manager under /settings/prompts[/*].
 *
 * Selected file is driven by the splat route param, keeping the URL shareable
 * and the back/forward buttons coherent.
 */
export function PromptsSection() {
  const { basePath, breakpoint } = useOutletContext<SettingsOutletContext>();
  const params = useParams();
  const navigate = useNavigate();

  // react-router v6 decodes splat params; fallback to '' means no file selected.
  const splat = params['*'] ?? '';
  const relativePath = splat || undefined;

  const handleSelect = useCallback((rel: string | null) => {
    if (rel) {
      navigate(`${basePath}/prompts/${encodeRelPath(rel)}`, { replace: true });
    } else {
      navigate(`${basePath}/prompts`, { replace: true });
    }
  }, [basePath, navigate]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-6 pt-6 pb-4 shrink-0 border-b border-border">
        <h2 className="text-base font-semibold">{t('settings.prompts.title')}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          {(() => {
            // settings.prompts.hint embeds $1 where the trigger char appears,
            // so we can render <code>/</code> in the middle of translated text.
            // Use a multi-char ASCII sentinel — single control chars (\u0000)
            // are stripped by chrome.i18n.getMessage substitution.
            const SENTINEL = '__CEBIAN_TRIGGER__';
            const parts = t('settings.prompts.hint', [SENTINEL]).split(SENTINEL);
            return <>{parts[0]}<code className="text-[11px]">/</code>{parts[1] ?? ''}</>;
          })()}
        </p>
      </div>
      <FileWorkspace
        root={CEBIAN_PROMPTS_DIR}
        relativePath={relativePath}
        onSelectRelative={handleSelect}
        newFileTemplate={PROMPT_TEMPLATE()}
        enableTemplateVars
        panelWidthStorage={settingsFilePanelWidth}
        compactMode={breakpoint === 'compact'}
        className="flex-1"
      />
    </div>
  );
}

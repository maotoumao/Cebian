import { useCallback, useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionNav } from './SectionNav';
import { lastSettingsSection } from '@/lib/storage';

interface SettingsLayoutProps {
  /** Absolute base path of the Settings hub (e.g. '/settings' in sidepanel). */
  basePath: string;
  /** Show the "← 返回" button in the top bar (sidepanel only). */
  showBackButton?: boolean;
}

/**
 * SettingsLayout — shell for the Settings hub.
 *
 * Top bar (optional back button + title) + SectionNav + <Outlet />.
 * Responsive nav layout (left vs top pills) and master-detail mode land in stage 3.
 */
export function SettingsLayout({ basePath, showBackButton = false }: SettingsLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();

  // Persist current section (path segment after basePath) so reopening lands here.
  const relative = location.pathname.startsWith(basePath)
    ? location.pathname.slice(basePath.length).replace(/^\//, '')
    : '';
  const section = relative.split('/')[0];
  useEffect(() => {
    if (section) lastSettingsSection.setValue(section);
  }, [section]);

  // Back button always exits Settings entirely — single-step escape, no history stepping.
  const handleBack = useCallback(() => {
    navigate('/chat/new', { replace: true });
  }, [navigate]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        {showBackButton && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleBack}
            aria-label="返回"
          >
            <ArrowLeft className="size-4.5" />
          </Button>
        )}
        <h1 className="font-semibold text-sm">设置</h1>
        {/* TODO(stage 4): "在新标签页打开" button (sidepanel only) carrying current location.pathname. */}
      </div>

      <div className="flex flex-1 min-h-0">
        <SectionNav basePath={basePath} />
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <Outlet context={{ basePath } satisfies SettingsOutletContext} />
        </div>
      </div>
    </div>
  );
}

/** Shared context passed from SettingsLayout to each section via <Outlet>. */
export interface SettingsOutletContext {
  /** Absolute base path of the Settings hub (e.g. '/settings'). */
  basePath: string;
}

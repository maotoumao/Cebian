import { useCallback, useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionNav } from './SectionNav';
import { lastSettingsSection } from '@/lib/storage';
import { useContainerWidth } from '@/hooks/useContainerWidth';

/** Breakpoint: below this width the Settings hub switches to compact layout. */
const COMPACT_BREAKPOINT = 640;

interface SettingsLayoutProps {
  /** Absolute base path of the Settings hub (e.g. '/settings' in sidepanel). */
  basePath: string;
  /** Show the "鈫?杩斿洖" button in the top bar (sidepanel only). */
  showBackButton?: boolean;
}

/**
 * SettingsLayout 鈥?shell for the Settings hub.
 *
 * Layout:
 * - Standard (鈮?40px): top bar 鈫?two columns (SectionNav left, Outlet right).
 * - Compact  (<640px): top bar 鈫?horizontal icon-only SectionNav 鈫?full-width Outlet.
 *
 * The `compact` flag is forwarded to sections via `SettingsOutletContext` so
 * they can opt into master-detail (FileWorkspace) or other compact adaptations.
 */
export function SettingsLayout({ basePath, showBackButton = false }: SettingsLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(containerRef);
  // Default to non-compact until first measurement to avoid a compact鈫抴ide flash
  // on the tab page. Sidepanel (~380px) flips to compact on the first measure.
  const compact = width !== null && width < COMPACT_BREAKPOINT;

  // Persist current section (path segment after basePath) so reopening lands here.
  const relative = location.pathname.startsWith(basePath)
    ? location.pathname.slice(basePath.length).replace(/^\//, '')
    : '';
  const section = relative.split('/')[0];
  useEffect(() => {
    if (section) lastSettingsSection.setValue(section);
  }, [section]);

  // Back button always exits Settings entirely 鈥?single-step escape, no history stepping.
  const handleBack = useCallback(() => {
    navigate('/chat/new', { replace: true });
  }, [navigate]);

  const outletCtx: SettingsOutletContext = { basePath, compact };

  return (
    <div ref={containerRef} className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        {showBackButton && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleBack}
            aria-label="杩斿洖"
          >
            <ArrowLeft className="size-4.5" />
          </Button>
        )}
        <h1 className="font-semibold text-sm">璁剧疆</h1>
        {/* TODO(stage 4): "鍦ㄦ柊鏍囩椤垫墦寮€" button (sidepanel only) carrying current location.pathname. */}
      </div>

      {compact ? (
        <div className="flex flex-col flex-1 min-h-0">
          <SectionNav basePath={basePath} compact />
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <Outlet context={outletCtx} />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          <SectionNav basePath={basePath} />
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <Outlet context={outletCtx} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Shared context passed from SettingsLayout to each section via <Outlet>. */
export interface SettingsOutletContext {
  /** Absolute base path of the Settings hub (e.g. '/settings'). */
  basePath: string;
  /** True when the Settings container is narrower than the compact breakpoint. */
  compact: boolean;
}
import { useCallback, useEffect, useRef } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { browser } from 'wxt/browser';
import { Button } from '@/components/ui/button';
import { SectionNav } from './SectionNav';
import { lastSettingsSection } from '@/lib/storage';
import { useContainerWidth } from '@/hooks/useContainerWidth';
import { t } from '@/lib/i18n';

/** Breakpoints for the Settings hub layout. */
const COMPACT_MAX = 640;   // below: compact (pills + master-detail)
const MEDIUM_MAX = 1200;   // below: medium (top icon+text tabs, two-column body)

export type SettingsBreakpoint = 'compact' | 'medium' | 'wide';

function resolveBreakpoint(width: number | null): SettingsBreakpoint {
  if (width === null || width >= MEDIUM_MAX) return 'wide';
  if (width < COMPACT_MAX) return 'compact';
  return 'medium';
}

interface SettingsLayoutProps {
  /** Absolute base path of the Settings hub (e.g. '/settings' in sidepanel). */
  basePath: string;
  /** Show the back button in the top bar (sidepanel only). */
  showBackButton?: boolean;
  /** Show the "open in new tab" button in the top bar (sidepanel only). */
  showOpenInTab?: boolean;
}

/**
 * SettingsLayout - shell for the Settings hub.
 *
 * Three responsive tiers:
 * - compact (<640px): top icon-only pills -> full-width Outlet (master-detail).
 * - medium (640-1200): top icon+text tabs -> full-width Outlet (two-column still).
 * - wide   (>=1200px): left labeled sidebar -> Outlet on the right.
 */
export function SettingsLayout({ basePath, showBackButton = false, showOpenInTab = false }: SettingsLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(containerRef);
  const breakpoint = resolveBreakpoint(width);

  // Persist current section (path segment after basePath) so reopening lands here.
  const relative = location.pathname.startsWith(basePath)
    ? location.pathname.slice(basePath.length).replace(/^\//, '')
    : '';
  const section = relative.split('/')[0];
  // Only persist the landing section when running inside the sidepanel
  // (showBackButton is our proxy for that). The tab page is deep-linkable via
  // hash and should not influence which section the sidepanel opens to next.
  useEffect(() => {
    if (section && showBackButton) lastSettingsSection.setValue(section);
  }, [section, showBackButton]);

  // Back button always exits Settings entirely - single-step escape.
  const handleBack = useCallback(() => {
    navigate('/chat/new', { replace: true });
  }, [navigate]);

  // Open the current Settings path in the standalone tab page.
  const handleOpenInTab = useCallback(() => {
    const url = browser.runtime.getURL('/settings.html') + '#/' + relative;
    void browser.tabs.create({ url });
  }, [relative]);

  const outletCtx: SettingsOutletContext = { basePath, breakpoint };

  const topNav = breakpoint !== 'wide';
  const navVariant = breakpoint === 'compact' ? 'pills' : breakpoint === 'medium' ? 'tabs' : 'labels';

  return (
    <div ref={containerRef} className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
        {showBackButton && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleBack}
            aria-label={t('common.back')}
          >
            <ArrowLeft className="size-4.5" />
          </Button>
        )}
        <h1 className="font-semibold text-sm">{t('common.settings')}</h1>
        {showOpenInTab && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleOpenInTab}
            aria-label={t('common.openInNewTab')}
            title={t('common.openInNewTab')}
            className="ml-auto"
          >
            <ExternalLink className="size-4" />
          </Button>
        )}
      </div>

      {topNav ? (
        <div className="flex flex-col flex-1 min-h-0">
          <SectionNav basePath={basePath} variant={navVariant} />
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <Outlet context={outletCtx} />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          <SectionNav basePath={basePath} variant="labels" />
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
  /** Resolved responsive breakpoint of the Settings container. */
  breakpoint: SettingsBreakpoint;
}
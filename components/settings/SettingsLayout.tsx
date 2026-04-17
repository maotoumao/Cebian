import { useCallback, useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionNav } from './SectionNav';
import { lastSettingsSection } from '@/lib/storage';

interface SettingsLayoutProps {
  /** Show the "← 返回" button in the top bar (sidepanel only). */
  showBackButton?: boolean;
}

/**
 * SettingsLayout — shell for the Settings hub.
 *
 * Top bar (optional back button + title) + SectionNav + <Outlet />.
 * Responsive nav layout (left vs top pills) and master-detail mode land in stage 3.
 */
export function SettingsLayout({ showBackButton = false }: SettingsLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();

  // Persist current section (second path segment) so `/settings` redirects here next time.
  const section = location.pathname.split('/')[2];
  useEffect(() => {
    if (section) lastSettingsSection.setValue(section);
  }, [section]);

  // Use the router's own history signal — `window.history.length` is meaningless under MemoryRouter.
  const canGoBack = location.key !== 'default';
  const handleBack = useCallback(() => {
    if (canGoBack) {
      navigate(-1);
    } else {
      navigate('/chat/new', { replace: true });
    }
  }, [canGoBack, navigate]);

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
        <SectionNav />
        <div className="flex-1 min-w-0 overflow-y-auto">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

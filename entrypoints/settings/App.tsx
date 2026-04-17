import { useState, useEffect } from 'react';
import { HashRouter } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SettingsRoutes } from '@/entrypoints/sidepanel/pages/settings';
import { useStorageItem } from '@/hooks/useStorageItem';
import { themePreference } from '@/lib/storage';

function resolveTheme(pref: 'dark' | 'light' | 'system'): 'dark' | 'light' {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(resolved: 'dark' | 'light') {
  if (resolved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

/**
 * Standalone Settings tab page.
 *
 * Hosts the full Settings hub at `/settings.html#/<section>[/<file>]`.
 * Uses HashRouter so deep-links like `#/skills/foo/SKILL.md` survive
 * navigation and can be opened from the sidepanel's "open in new tab" button.
 */
export default function App() {
  const [theme] = useStorageItem(themePreference, 'system');
  const [themeReady, setThemeReady] = useState(false);

  useEffect(() => {
    themePreference.getValue().then((val) => {
      applyTheme(resolveTheme(val ?? 'system'));
      setThemeReady(true);
    });
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    applyTheme(resolveTheme(theme));
  }, [theme, themeReady]);

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => applyTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  if (!themeReady) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen bg-background text-foreground">
        <HashRouter>
          <SettingsRoutes basePath="" />
        </HashRouter>
      </div>
    </TooltipProvider>
  );
}

import { useState, useEffect } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AIConfigContent } from '@/components/ai-config/AIConfigContent';
import { useStorageItem } from '@/hooks/useStorageItem';
import { themePreference, aiConfigPagePanelWidth } from '@/lib/storage';

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
        <header className="flex items-center px-5 py-3 border-b border-border shrink-0">
          <h1 className="text-base font-semibold">AI 配置</h1>
        </header>
        <AIConfigContent
          panelWidthStorage={aiConfigPagePanelWidth}
          defaultPanelWidth={280}
          className="flex-1 min-h-0"
        />
      </div>
    </TooltipProvider>
  );
}

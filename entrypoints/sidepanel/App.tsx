import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { DialogOutlet } from '@/components/dialogs/outlet';
import { Header } from '@/components/layout/Header';
import { HistoryPanel } from '@/components/layout/HistoryPanel';
import { useStorageItem } from '@/hooks/useStorageItem';
import { themePreference } from '@/lib/storage';
import { showDialog } from '@/lib/dialog';
import { AI_CONFIG_MIN_DIALOG_WIDTH } from '@/lib/constants';
import { ChatPage } from './pages/chat';
import { SettingsRoutes } from './pages/settings';

/** Resolve 'system' to the actual theme based on OS preference (defaults to 'light'). */
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

function App() {
  const [theme, setTheme] = useStorageItem(themePreference, 'system');
  const [themeReady, setThemeReady] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatTitle, setChatTitle] = useState('');

  const navigate = useNavigate();
  const location = useLocation();

  // Load theme from storage before first render
  useEffect(() => {
    themePreference.getValue().then((val) => {
      applyTheme(resolveTheme(val ?? 'system'));
      setThemeReady(true);
    });
  }, []);

  // Sync theme changes after initial load
  useEffect(() => {
    if (!themeReady) return;
    applyTheme(resolveTheme(theme));
  }, [theme, themeReady]);

  // Listen for OS theme changes when in 'system' mode
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => applyTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  const toggleTheme = () => {
    const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    setTheme(next);
  };

  const handleNewChat = useCallback(() => {
    // If already on /chat/new, do nothing
    if (location.pathname === '/chat/new') return;
    setChatTitle('');
    navigate('/chat/new');
  }, [location.pathname, navigate]);

  const handleSelectSession = useCallback((sessionId: string) => {
    setHistoryOpen(false);
    setChatTitle('');
    navigate(`/chat/${sessionId}`);
  }, [navigate]);

  const handleDeleteSession = useCallback((deletedId: string) => {
    // If the deleted session is the one currently open, redirect to new chat
    if (location.pathname === `/chat/${deletedId}`) {
      navigate('/chat/new', { replace: true });
    }
  }, [location.pathname, navigate]);

  if (!themeReady) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen overflow-hidden relative">
        {!location.pathname.startsWith('/settings') && (
          <Header
            title={chatTitle}
            theme={theme}
            onToggleTheme={toggleTheme}
            onOpenSettings={() => navigate('/settings')}
            onOpenAIConfig={() => {
              const width = document.documentElement.clientWidth;
              if (width >= AI_CONFIG_MIN_DIALOG_WIDTH) {
                showDialog('ai-config', {});
              } else {
                chrome.tabs.create({ url: browser.runtime.getURL('/ai-config.html') });
              }
            }}
            onNewChat={handleNewChat}
            onOpenHistory={() => setHistoryOpen(true)}
          />
        )}

        <Routes>
          <Route path="/chat/new" element={<ChatPage onOpenSettings={() => navigate('/settings')} onTitleChange={setChatTitle} />} />
          <Route path="/chat/:sessionId" element={<ChatPage onOpenSettings={() => navigate('/settings')} onTitleChange={setChatTitle} />} />
          <Route path="/settings/*" element={<SettingsRoutes showBackButton />} />
          <Route path="*" element={<Navigate to="/chat/new" replace />} />
        </Routes>

        <HistoryPanel
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
        />

        <Toaster theme={resolveTheme(theme)} />
        <DialogOutlet />
      </div>
    </TooltipProvider>
  );
}

export default App;

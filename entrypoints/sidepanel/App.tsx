import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { DialogOutlet } from '@/components/dialogs/outlet';
import { ConfirmOutlet } from '@/components/dialogs/confirm-outlet';
import { UpdateNoticeOutlet } from '@/components/dialogs/update-notice-outlet';
import { Header } from '@/components/layout/Header';
import { HistoryPanel } from '@/components/layout/HistoryPanel';
import { useStorageItem } from '@/hooks/useStorageItem';
import { useChangelogOnUpdate } from '@/hooks/useChangelogOnUpdate';
import { themePreference } from '@/lib/persistence/storage';
import { ChatPage } from './pages/chat';

// Lazy-load Settings: pulls in CodeMirror, react-arborist, lightning-fs,
// all provider/MCP forms, etc. — a large chunk that's only needed once
// the user opens /settings. Keeping it out of the sidepanel's initial
// bundle is the single biggest first-paint win.
const SettingsRoutes = lazy(() =>
  import('./pages/settings').then(m => ({ default: m.SettingsRoutes })),
);

/** Resolve 'system' to the actual theme based on OS preference (defaults to 'light'). */
function resolveTheme(pref: 'dark' | 'light' | 'system'): 'dark' | 'light' {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(resolved: 'dark' | 'light') {
  document.documentElement.setAttribute('data-theme', resolved);
}

function App() {
  const [theme, setTheme] = useStorageItem(themePreference, 'system');
  const [themeReady, setThemeReady] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatTitle, setChatTitle] = useState('');

  const navigate = useNavigate();
  const location = useLocation();

  // 记住最近访问过的聊天路由（/chat/new 或 /chat/:sessionId），供退出设置时回到原处。
  // 缺省 /chat/new 兜底首次进设置的情况。
  const lastChatPathRef = useRef('/chat/new');
  useEffect(() => {
    if (location.pathname.startsWith('/chat/')) {
      lastChatPathRef.current = location.pathname;
    }
  }, [location.pathname]);

  // 侧边栏打开后，若后台在升级时留了「待展示更新日志」标记，则打开更新日志页。
  useChangelogOnUpdate();

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
    // If we're already viewing this session, do nothing — clearing chatTitle
    // and navigate-to-same-path would wipe the header without triggering a
    // resubscribe/IPC roundtrip to repopulate it.
    if (location.pathname === `/chat/${sessionId}`) return;
    setChatTitle('');
    navigate(`/chat/${sessionId}`);
  }, [location.pathname, navigate]);

  const handleDeleteSession = useCallback((deletedId: string) => {
    // If the deleted session is the one currently open, redirect to new chat
    if (location.pathname === `/chat/${deletedId}`) {
      navigate('/chat/new', { replace: true });
    }
  }, [location.pathname, navigate]);

  // 退出设置：回到进设置前的聊天路由（记不到则 /chat/new 兜底）。
  const handleExitSettings = useCallback(() => {
    navigate(lastChatPathRef.current, { replace: true });
  }, [navigate]);

  if (!themeReady) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen overflow-hidden relative">
        {!location.pathname.startsWith('/settings') && (
          <Header
            title={chatTitle}
            isNewChat={location.pathname === '/chat/new'}
            theme={theme}
            onToggleTheme={toggleTheme}
            onOpenSettings={() => navigate('/settings')}
            onNewChat={handleNewChat}
            onOpenHistory={() => setHistoryOpen(true)}
          />
        )}

        <Routes>
          <Route path="/chat/new" element={<ChatPage onOpenSettings={() => navigate('/settings')} onTitleChange={setChatTitle} />} />
          <Route path="/chat/:sessionId" element={<ChatPage onOpenSettings={() => navigate('/settings')} onTitleChange={setChatTitle} />} />
          <Route
            path="/settings/*"
            element={
              <Suspense fallback={null}>
                <SettingsRoutes basePath="/settings" showBackButton showOpenInTab onBack={handleExitSettings} />
              </Suspense>
            }
          />
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
        <ConfirmOutlet />
        <UpdateNoticeOutlet />
      </div>
    </TooltipProvider>
  );
}

export default App;

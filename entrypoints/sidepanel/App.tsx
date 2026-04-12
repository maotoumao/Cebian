import { useState, useEffect, useCallback } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Header } from '@/components/layout/Header';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { HistoryPanel } from '@/components/layout/HistoryPanel';
import { useStorageItem } from '@/hooks/useStorageItem';
import { themePreference } from '@/lib/storage';
import { ChatPage } from './pages/chat';

function App() {
  const [theme, setTheme] = useStorageItem(themePreference, 'dark');
  const [themeReady, setThemeReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [chatTitle, setChatTitle] = useState('');

  const navigate = useNavigate();
  const location = useLocation();

  // Load theme from storage before first render
  useEffect(() => {
    themePreference.getValue().then((val) => {
      const t = val ?? 'dark';
      if (t === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
      } else {
        document.documentElement.removeAttribute('data-theme');
      }
      setThemeReady(true);
    });
  }, []);

  // Sync theme changes after initial load
  useEffect(() => {
    if (!themeReady) return;
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, [theme, themeReady]);

  const toggleTheme = () =>
    setTheme(theme === 'dark' ? 'light' : 'dark');

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
        <Header
          title={chatTitle}
          theme={theme}
          onToggleTheme={toggleTheme}
          onOpenSettings={() => setSettingsOpen(true)}
          onNewChat={handleNewChat}
          onOpenHistory={() => setHistoryOpen(true)}
        />

        <Routes>
          <Route path="/chat/new" element={<ChatPage onOpenSettings={() => setSettingsOpen(true)} onTitleChange={setChatTitle} />} />
          <Route path="/chat/:sessionId" element={<ChatPage onOpenSettings={() => setSettingsOpen(true)} onTitleChange={setChatTitle} />} />
          <Route path="*" element={<Navigate to="/chat/new" replace />} />
        </Routes>

        <SettingsPanel
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />

        <HistoryPanel
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
        />
      </div>
    </TooltipProvider>
  );
}

export default App;

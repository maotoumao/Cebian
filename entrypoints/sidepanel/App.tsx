import { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Header } from '@/components/layout/Header';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { useStorageItem } from '@/hooks/useStorageItem';
import { themePreference } from '@/lib/storage';
import { ChatPage } from './pages/chat';
import { TasksPage } from './pages/tasks';

function App() {
  const [theme, setTheme] = useStorageItem(themePreference, 'dark');
  const [themeReady, setThemeReady] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  if (!themeReady) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen overflow-hidden relative">
        <Header
          theme={theme}
          onToggleTheme={toggleTheme}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <Routes>
          <Route path="/chat" element={<ChatPage onOpenSettings={() => setSettingsOpen(true)} />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>

        <SettingsPanel
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      </div>
    </TooltipProvider>
  );
}

export default App;

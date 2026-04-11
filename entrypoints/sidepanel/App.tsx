import { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Header } from '@/components/chat/Header';
import { SettingsPanel } from '@/components/chat/SettingsPanel';
import { ChatPage } from './pages/chat';
import { TasksPage } from './pages/tasks';

type Theme = 'dark' | 'light';

function App() {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('cebian-theme') as Theme) || 'dark',
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem('cebian-theme', theme);
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, [theme]);

  const toggleTheme = () =>
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen overflow-hidden relative">
        <Header
          theme={theme}
          onToggleTheme={toggleTheme}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <Routes>
          <Route path="/chat" element={<ChatPage />} />
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

import { Sun, Moon, Settings, MessageSquare, Clock } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface HeaderProps {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onOpenSettings: () => void;
}

const NAV_ITEMS = [
  { path: '/chat', label: '对话', icon: MessageSquare },
  { path: '/tasks', label: '任务', icon: Clock },
] as const;

export function Header({ theme, onToggleTheme, onOpenSettings }: HeaderProps) {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <header className="flex items-center justify-between px-5 py-4 border-b border-border bg-background/80 backdrop-blur-xl z-10">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 bg-primary rounded grid place-items-center text-primary-foreground font-mono text-xs font-bold">
            C
          </div>
          <span className="font-semibold text-[1.1rem] tracking-tight">
            Cebian
          </span>
        </div>

        <nav className="flex gap-1">
          {NAV_ITEMS.map(({ path, label, icon: Icon }) => {
            const isActive = location.pathname === path;
            return (
              <Tooltip key={path}>
                <TooltipTrigger asChild>
                  <Button
                    variant={isActive ? 'secondary' : 'ghost'}
                    size="icon-xs"
                    onClick={() => navigate(path)}
                  >
                    <Icon className="size-[18px]" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            );
          })}
        </nav>
      </div>

      <div className="flex gap-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onToggleTheme}
            >
              {theme === 'dark' ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>切换主题</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onOpenSettings}
            >
              <Settings className="size-[18px]" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>设置</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

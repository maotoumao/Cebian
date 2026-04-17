import { Sun, Moon, Monitor, Settings, SquarePen, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface HeaderProps {
  title?: string;
  theme: 'dark' | 'light' | 'system';
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onNewChat: () => void;
  onOpenHistory: () => void;
}

export function Header({ title, theme, onToggleTheme, onOpenSettings, onNewChat, onOpenHistory }: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-5 py-4 border-b border-border bg-background/80 backdrop-blur-xl z-10">
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={onNewChat}>
              <SquarePen className="size-4.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>新对话</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={onOpenHistory}>
              <History className="size-4.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>历史记录</TooltipContent>
        </Tooltip>
      </div>

      <span className="flex-1 text-center text-sm font-medium truncate px-2">
        {title}
      </span>

      <div className="flex gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onToggleTheme}
            >
              {theme === 'system' ? <Monitor className="size-4.5" /> : theme === 'dark' ? <Sun className="size-4.5" /> : <Moon className="size-4.5" />}
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
              <Settings className="size-4.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>设置</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

import { Sun, Moon, Monitor, Settings, SquarePen, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { t } from '@/lib/i18n';

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
          <TooltipContent>{t('common.newChat')}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={onOpenHistory}>
              <History className="size-4.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('common.history')}</TooltipContent>
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
              {theme === 'system' ? <Monitor className="size-4.5" /> : theme === 'dark' ? <Moon className="size-4.5" /> : <Sun className="size-4.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('common.toggleTheme')}</TooltipContent>
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
          <TooltipContent>{t('common.settings')}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}

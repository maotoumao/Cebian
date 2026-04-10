import { Sun, Moon, Settings } from 'lucide-react';
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

export function Header({ theme, onToggleTheme, onOpenSettings }: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-5 py-4 border-b border-border bg-background/80 backdrop-blur-xl z-10">
      <div className="flex items-center gap-2">
        <div className="w-5 h-5 bg-primary rounded grid place-items-center text-primary-foreground font-mono text-xs font-bold">
          C
        </div>
        <span className="font-semibold text-[1.1rem] tracking-tight">
          Cebian
        </span>
      </div>

      <div className="flex gap-1">
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

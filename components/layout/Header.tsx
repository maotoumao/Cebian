import { useEffect, useState } from 'react';
import { Sun, Moon, SunMoon, Settings, SquarePen, History, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InlineRenameInput } from '@/components/common/InlineRenameInput';
import { MAX_SESSION_TITLE_LENGTH } from '@/lib/agent/session-title';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { t } from '@/lib/i18n';

interface HeaderProps {
  title?: string;
  /** 是否处于新会话路由（/chat/new）。新会话且无标题时，标题位回落显示品牌名。 */
  isNewChat?: boolean;
  theme: 'dark' | 'light' | 'system';
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  onNewChat: () => void;
  onOpenHistory: () => void;
  /** 提供时标题可点击进入行内改名（仅已有会话且标题非空时由 App 传入）。 */
  onRename?: (title: string) => void;
}

export function Header({ title, isNewChat, theme, onToggleTheme, onOpenSettings, onNewChat, onOpenHistory, onRename }: HeaderProps) {
  const [renaming, setRenaming] = useState(false);
  // 编辑途中入口被收回（切到新会话 / 设置）：退出编辑态，别让输入框悬在一个不能改名的页面上。
  useEffect(() => {
    if (!onRename) setRenaming(false);
  }, [onRename]);
  const renameLabel = t('common.rename');

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

      {renaming && title ? (
        <InlineRenameInput
          initial={title}
          ariaLabel={renameLabel}
          maxLength={MAX_SESSION_TITLE_LENGTH}
          onCommit={(next) => {
            setRenaming(false);
            onRename?.(next);
          }}
          onCancel={() => setRenaming(false)}
          className="flex-1 mx-2 text-center text-sm font-medium"
        />
      ) : onRename && title ? (
        <button
          type="button"
          onClick={() => setRenaming(true)}
          title={renameLabel}
          aria-label={t('common.session.renameChat', [title])}
          className="group flex-1 min-w-0 flex items-center justify-center gap-1 px-2 text-sm font-medium"
        >
          <span className="truncate">{title}</span>
          <Pencil aria-hidden className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
      ) : (
        <span className="flex-1 text-center text-sm font-medium truncate px-2">
          {title || (isNewChat ? 'Cebian' : '')}
        </span>
      )}

      <div className="flex gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onToggleTheme}
            >
              {theme === 'system' ? <SunMoon className="size-4.5" /> : theme === 'dark' ? <Moon className="size-4.5" /> : <Sun className="size-4.5" />}
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

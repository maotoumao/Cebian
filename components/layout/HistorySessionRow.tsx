// 历史列表的一行。从 HistoryPanel 拆出来，因为多选模式让「一行长什么样」自成一档：
// 普通态是点开会话 + 悬停操作，选择态是勾选框 + 点行即勾选。

import { useRef, useState } from 'react';
import { Archive, ArchiveRestore, CheckSquare, Ellipsis, GitFork, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InlineRenameInput } from '@/components/common/InlineRenameInput';
import { MAX_SESSION_TITLE_LENGTH } from '@/lib/agent/session-title';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { SessionMeta } from '@/lib/ipc/protocol';
import { t } from '@/lib/i18n';

interface HistorySessionRowProps {
  session: SessionMeta;
  /** 相对时间，由父组件统一格式化（一次渲染共用同一个「现在」）。 */
  relativeTime: string;
  /** 分叉来源会话的标题（issue #60）。仅当 `session.parentSessionId` 存在时有意义：
   *  undefined = 源会话已不在列表（被删），标记退化为不可点的提示。 */
  forkSourceTitle?: string;
  selectionMode: boolean;
  selected: boolean;
  /** 普通态：打开会话。选择态：切换勾选（带 shiftKey 表示区间选择）。 */
  onOpen: (sessionId: string) => void;
  onToggleSelect: (sessionId: string, shiftKey: boolean) => void;
  onEnterSelection: (sessionId: string) => void;
  onTogglePin: (session: SessionMeta) => void;
  onToggleArchive: (session: SessionMeta) => void;
  onDelete: (sessionId: string) => void;
  /** 行内改名提交（已 trim 且与原标题不同）。 */
  onRename: (sessionId: string, title: string) => void;
}

/**
 * 分叉来源标记（issue #60）：源会话仍在时是一个可点的小按钮（跳到源会话），源会话已删
 * 或处于选择态时退化为纯提示图标——选择态下整行都是勾选命中区，不该再有别的导航。
 */
function ForkSourceMarker({
  parentSessionId,
  sourceTitle,
  onOpen,
}: {
  parentSessionId: string;
  sourceTitle: string | undefined;
  /** 缺省 = 不可点（选择态 / 源已删）。 */
  onOpen?: (sessionId: string) => void;
}) {
  const hint = sourceTitle !== undefined
    ? t('common.session.forkedFrom', [sourceTitle])
    : t('common.session.forkedFromUnknown');
  if (!onOpen || sourceTitle === undefined) {
    return (
      <span role="img" aria-label={hint} title={hint} className="shrink-0 text-muted-foreground">
        <GitFork aria-hidden className="size-3" />
      </span>
    );
  }
  // 悬停提示沿用本文件其它按钮的 title 属性；可访问名用动作式文案（按钮说明「做什么」）。
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
      aria-label={t('common.session.openForkSource', [sourceTitle])}
      title={hint}
      // 行本身是 role="button"：点击 / 键盘事件就地拦下，否则会顺带打开当前会话。
      onClick={(e) => {
        e.stopPropagation();
        onOpen(parentSessionId);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <GitFork className="size-3" />
    </Button>
  );
}

export function HistorySessionRow({
  session,
  relativeTime,
  forkSourceTitle,
  selectionMode,
  selected,
  onOpen,
  onToggleSelect,
  onEnterSelection,
  onTogglePin,
  onToggleArchive,
  onDelete,
  onRename,
}: HistorySessionRowProps) {
  const pinned = session.pinnedAt != null;
  const archived = session.archivedAt != null;
  const [renaming, setRenaming] = useState(false);
  // 从菜单进入改名：`onSelect` 触发时菜单还开着、焦点锁仍生效，此刻挂输入框会被立刻抢回焦点
  // （blur → 退出编辑）；关闭时 Radix 又会把焦点还给触发按钮。所以 onSelect 只记意图，等
  // onCloseAutoFocus（焦点锁已解除）阻止默认的焦点恢复后，再真正进入编辑态。
  const renameFromMenuRef = useRef(false);

  const activate = (shiftKey: boolean) => {
    if (selectionMode) onToggleSelect(session.id, shiftKey);
    else onOpen(session.id);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selectionMode ? selected : undefined}
      className="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-muted/50 transition-colors group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={(e) => activate(e.shiftKey)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate(e.shiftKey);
        }
      }}
    >
      {selectionMode && (
        // 勾选框本身不接管点击：整行都是命中区，点哪儿都算勾选，窄面板里更好点。
        // aria-hidden：Radix Checkbox 渲染的是 role="checkbox" 的按钮，嵌在 role="button"
        // 的行里属于非法的嵌套可交互角色；选中态已由行上的 aria-pressed 播报，这里纯装饰。
        <Checkbox
          checked={selected}
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none shrink-0"
        />
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          {session.isRunning && (
            <span
              role="img"
              aria-label={t('common.session.running')}
              title={t('common.session.running')}
              className="size-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0"
            />
          )}
          {pinned && <Pin aria-hidden className="size-3 shrink-0 text-muted-foreground" />}
          {session.parentSessionId && (
            <ForkSourceMarker
              parentSessionId={session.parentSessionId}
              sourceTitle={forkSourceTitle}
              onOpen={selectionMode ? undefined : onOpen}
            />
          )}
          {renaming ? (
            <InlineRenameInput
              initial={session.title}
              ariaLabel={t('common.rename')}
              maxLength={MAX_SESSION_TITLE_LENGTH}
              onCommit={(next) => {
                setRenaming(false);
                onRename(session.id, next);
              }}
              onCancel={() => setRenaming(false)}
              className="flex-1 text-sm font-medium"
            />
          ) : (
            <div className="text-sm font-medium truncate min-w-0">{session.title}</div>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
          {session.model && <span>{session.model}</span>}
          <span>·</span>
          <span>{t('common.session.messageCount', session.messageCount)}</span>
          <span>·</span>
          <span>{relativeTime}</span>
        </div>
      </div>

      {/* Row actions: pin is one click (frequent, reversible), the rest go in the overflow
          menu. While selecting, the row only toggles — these yield to the batch bar. */}
      {!selectionMode && (
        <div
          className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"
          // 行本身是 role="button"，点击 / 回车都会打开会话。操作区里的事件必须就地
          // 拦下，否则按一下「置顶」会顺带把会话打开。
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            aria-label={pinned ? t('common.session.unpin') : t('common.session.pin')}
            title={pinned ? t('common.session.unpin') : t('common.session.pin')}
            onClick={() => onTogglePin(session)}
          >
            {pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label={t('common.moreActions')}
              >
                <Ellipsis className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-44 max-w-[calc(100vw-1rem)]"
              onCloseAutoFocus={(e) => {
                if (renameFromMenuRef.current) {
                  renameFromMenuRef.current = false;
                  e.preventDefault();
                  setRenaming(true);
                }
              }}
            >
              <DropdownMenuItem
                onSelect={() => {
                  renameFromMenuRef.current = true;
                }}
              >
                <Pencil />
                <span className="min-w-0 break-words">{t('common.rename')}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onToggleArchive(session)}>
                {archived ? <ArchiveRestore /> : <Archive />}
                <span className="min-w-0 break-words">
                  {archived ? t('common.session.unarchive') : t('common.session.archive')}
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onEnterSelection(session.id)}>
                <CheckSquare />
                <span className="min-w-0 break-words">{t('common.session.select')}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => onDelete(session.id)}>
                <Trash2 />
                <span className="min-w-0 break-words">{t('common.delete')}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

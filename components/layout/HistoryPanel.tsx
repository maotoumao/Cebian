import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, ArrowLeft, MessageSquare, Pin, PinOff, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { type SessionMeta } from '@/lib/ipc/protocol';
import type { SessionPlacement } from '@/lib/persistence/db';
import { useSessionList } from '@/hooks/useSessionList';
import { COLLAPSED_BUCKETS, groupSessions } from '@/components/layout/history-grouping';
import { rangeBetween, visibleOrder } from '@/components/layout/history-selection';
import { HistorySessionRow } from '@/components/layout/HistorySessionRow';
import { toast } from 'sonner';
import { showConfirm } from '@/lib/ui/dialog';
import { t } from '@/lib/i18n';

interface HistoryPanelProps {
  open: boolean;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return t('common.time.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('common.time.minutesAgo', [minutes]);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('common.time.hoursAgo', [hours]);
  const days = Math.floor(hours / 24);
  if (days < 30) return t('common.time.daysAgo', [days]);
  const months = Math.floor(days / 30);
  if (months < 12) return t('common.time.monthsAgo', [months]);
  return t('common.time.yearsAgo', [Math.floor(months / 12)]);
}

export function HistoryPanel({ open, onClose, onSelectSession, onDeleteSession }: HistoryPanelProps) {
  // 列表 + 删除 + 置顶/归档都走 useSessionList 持有的那一条长连接端口。列表带着后台才
  // 知道的 `isRunning`（DB 不知道哪些 agent 正在流式），所以不能直接读库。
  const { sessions, loading, remove, setPlacement, rename } = useSessionList(open);

  // 分组边界只随列表变化重算（`Date.now()` 不进依赖）；每行的相对时间则在每次渲染时
  // 现算，免得面板长时间开着而时间文案冻在最后一次列表更新的时刻。
  const groups = useMemo(() => groupSessions(sessions, Date.now()), [sessions]);

  // Accordion 必须是受控的：本面板从不卸载（App 里始终挂着，只靠 translate 滑进滑出），
  // 非受控的 defaultValue 只在首次挂载时读一次，此后新冒出来的分组（第一次置顶、某个
  // 时间段重新有会话）会渲染成折叠态，与「默认展开」的意图相反。
  //
  // 规则：只对「第一次出现」的分组做默认展开，此后交给用户——已展开 / 已折叠的分组不会
  // 因为列表刷新被强行改回去。分组整个消失时连同它的记忆一起丢掉：它再出现时是一个全新
  // 的分组，重新走默认规则（否则用户曾展开过「已归档」，清空再归档一条新的，它会自动
  // 展开，而归档的本意恰恰是「从眼前拿走」）。
  const [openBuckets, setOpenBuckets] = useState<string[]>([]);
  const seenBucketsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const present = groups.map((g) => g.bucket);
    const presentSet = new Set<string>(present);
    const fresh = present.filter((b) => !seenBucketsRef.current.has(b));
    seenBucketsRef.current = presentSet;
    setOpenBuckets((prev) => {
      const kept = prev.filter((b) => presentSet.has(b));
      // 已归档默认折叠——「拿走不碍事」的东西，展开它该是一次主动动作。
      const opened = fresh.filter((b) => !COLLAPSED_BUCKETS.includes(b) && !kept.includes(b));
      if (opened.length === 0 && kept.length === prev.length) return prev;
      return [...kept, ...opened];
    });
  }, [groups]);

  // 选择模式：`null` = 不在选择模式。用一个可空集合而不是「布尔 + 集合」，省掉两者可能
  // 互相矛盾的状态（在选择模式却没有集合 / 有集合却不在选择模式）。
  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null);
  const selectionMode = selectedIds !== null;
  // shift 区间选择的锚点：上一次「不带 shift」点过的那条。
  const anchorRef = useRef<string | null>(null);
  const exitButtonRef = useRef<HTMLButtonElement>(null);

  // 进入选择模式会把行内操作区整个卸掉，而「选择」正是从那里的下拉菜单点进来的——
  // Radix 收尾时想把焦点还给已经不存在的触发按钮，键盘用户的焦点就掉到 body 上了。
  // 等它还完（下一帧）再把焦点放到退出按钮上，既接住焦点也顺带告诉用户怎么退出。
  useEffect(() => {
    if (!selectionMode) return;
    const frame = requestAnimationFrame(() => exitButtonRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [selectionMode]);

  const exitSelection = () => {
    setSelectedIds(null);
    anchorRef.current = null;
  };

  // 关闭面板时退出选择模式，下次打开是干净状态（面板不卸载，状态不会自己没掉）。
  useEffect(() => {
    if (!open) {
      setSelectedIds(null);
      anchorRef.current = null;
    }
  }, [open]);

  // 列表变了（别的窗口删了会话）时，把已选集合里失效的 id 摘掉，免得批量操作发出一批
  // 根本不存在的 id。
  useEffect(() => {
    setSelectedIds((prev) => {
      if (!prev) return prev;
      const alive = new Set(sessions.map((s) => s.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [sessions]);

  const selectedSessions = useMemo(
    () => (selectedIds ? sessions.filter((s) => selectedIds.has(s.id)) : []),
    [sessions, selectedIds],
  );

  // 分叉会话的来源标题查表（issue #60）：源会话已删时查不到，行上退化为通用提示。
  const titleById = useMemo(
    () => new Map(sessions.map((s) => [s.id, s.title] as const)),
    [sessions],
  );

  const enterSelection = (sessionId: string) => {
    setSelectedIds(new Set([sessionId]));
    anchorRef.current = sessionId;
  };

  const toggleSelect = (sessionId: string, shiftKey: boolean) => {
    const anchor = anchorRef.current;
    // 区间一律「加选」而非逐个切换：shift 的语义是把这一段拉进来，不该把段内已选的抠掉。
    // range 为 null = 没有有效区间（锚点已失效）：退化成单选，并把锚点换成本次点击的
    // 这条，否则失效锚点会一直卡住后续每一次 shift 点击。
    const range = shiftKey && anchor
      ? rangeBetween(visibleOrder(groups, openBuckets), anchor, sessionId)
      : null;
    if (!range) anchorRef.current = sessionId;
    setSelectedIds((prev) => {
      const next = new Set(prev ?? []);
      if (range) {
        for (const id of range) next.add(id);
        return next;
      }
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const deleteSessions = async (ids: string[]) => {
    if (ids.length === 0) return;
    // 单条删除沿用带标题的旧文案（更具体）；批量用带数量的那套。
    const single = ids.length === 1 ? sessions.find((s) => s.id === ids[0]) : undefined;
    const ok = await showConfirm({
      title: single
        ? t('common.session.deleteConfirmTitle')
        : t('common.session.deleteManyConfirmTitle', ids.length),
      description: single
        ? t('common.session.deleteConfirmDescription', [single.title])
        : t('common.session.deleteManyConfirmDescription', ids.length),
      destructive: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    // 请求没发出去（端口断了）时会话还在，就不能把用户从这些会话上跳走。
    if (!remove(ids)) return;
    for (const id of ids) onDeleteSession?.(id);
    if (selectionMode) exitSelection();
  };

  /** 行内改名提交。请求没发出去（端口断了）要出声，否则输入框一收、什么都没发生。 */
  const renameSession = (id: string, title: string) => {
    if (!rename(id, title)) toast.error(t('chat.session.notConnected'));
  };

  /** 置顶 / 归档的切换：整批都已经是该状态就取消（回到普通），否则设成它。 */
  const togglePlacement = (targets: SessionMeta[], placement: Exclude<SessionPlacement, null>) => {
    if (targets.length === 0) return;
    const field = placement === 'pinned' ? 'pinnedAt' : 'archivedAt';
    const allSet = targets.every((s) => s[field] != null);
    setPlacement(targets.map((s) => s.id), allSet ? null : placement);
  };

  const hasSelection = selectedSessions.length > 0;
  const allSelectedPinned = hasSelection && selectedSessions.every((s) => s.pinnedAt != null);
  const allSelectedArchived = hasSelection && selectedSessions.every((s) => s.archivedAt != null);

  return (
    <div
      className={`absolute inset-0 bg-background z-50 flex flex-col transition-transform duration-300 ease-out ${
        open ? 'translate-x-0' : 'translate-x-full'
      }`}
    >
      {/* Header — doubles as the batch action bar while selecting, rather than a floating
          bottom bar that would permanently cover part of an already narrow list. */}
      <div className="flex items-center gap-2 px-5 py-4 border-b border-border">
        {selectionMode ? (
          <>
            <Button
              ref={exitButtonRef}
              variant="ghost"
              size="icon-xs"
              aria-label={t('common.cancel')}
              onClick={exitSelection}
            >
              <X className="size-5" />
            </Button>
            <span className="font-semibold text-sm truncate min-w-0">
              {t('common.session.selectedCount', selectedSessions.length)}
            </span>
            <div className="flex items-center gap-0.5 ml-auto shrink-0">
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={!hasSelection}
                aria-label={allSelectedPinned ? t('common.session.unpin') : t('common.session.pin')}
                title={allSelectedPinned ? t('common.session.unpin') : t('common.session.pin')}
                onClick={() => togglePlacement(selectedSessions, 'pinned')}
              >
                {allSelectedPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={!hasSelection}
                aria-label={allSelectedArchived ? t('common.session.unarchive') : t('common.session.archive')}
                title={allSelectedArchived ? t('common.session.unarchive') : t('common.session.archive')}
                onClick={() => togglePlacement(selectedSessions, 'archived')}
              >
                {allSelectedArchived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground hover:text-destructive"
                disabled={!hasSelection}
                aria-label={t('common.delete')}
                title={t('common.delete')}
                onClick={() => deleteSessions(selectedSessions.map((s) => s.id))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </>
        ) : (
          <>
            <Button variant="ghost" size="icon-xs" aria-label={t('common.back')} onClick={onClose}>
              <ArrowLeft className="size-5" />
            </Button>
            <span className="font-semibold">{t('common.history')}</span>
          </>
        )}
      </div>

      {/* Body */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-5 py-3">
          {loading && (
            <div className="text-center text-sm text-muted-foreground py-12">
              {t('common.loading')}
            </div>
          )}

          {!loading && sessions.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <MessageSquare className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t('common.empty.history')}</p>
            </div>
          )}

          {!loading && groups.length > 0 && (
            <Accordion type="multiple" value={openBuckets} onValueChange={setOpenBuckets}>
              {groups.map((group) => (
                <AccordionItem key={group.bucket} value={group.bucket} className="border-b-0">
                  <AccordionTrigger className="py-2 text-xs text-muted-foreground hover:no-underline">
                    {t(`common.historyGroup.${group.bucket}`)}
                  </AccordionTrigger>
                  <AccordionContent className="pb-1">
                    <div className="flex flex-col gap-1">
                      {group.sessions.map((session) => (
                        <HistorySessionRow
                          key={session.id}
                          session={session}
                          relativeTime={formatRelativeTime(session.updatedAt)}
                          forkSourceTitle={
                            session.parentSessionId ? titleById.get(session.parentSessionId) : undefined
                          }
                          selectionMode={selectionMode}
                          selected={selectedIds?.has(session.id) ?? false}
                          onOpen={onSelectSession}
                          onToggleSelect={toggleSelect}
                          onEnterSelection={enterSelection}
                          onTogglePin={(s) => togglePlacement([s], 'pinned')}
                          onToggleArchive={(s) => togglePlacement([s], 'archived')}
                          onDelete={(id) => deleteSessions([id])}
                          onRename={renameSession}
                        />
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

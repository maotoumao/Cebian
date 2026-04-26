import { useState, useEffect } from 'react';
import { ArrowLeft, Trash2, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AGENT_PORT_NAME, type ClientMessage, type ServerMessage, type SessionMeta } from '@/lib/protocol';
import { showConfirm } from '@/lib/dialog';
import { t } from '@/lib/i18n';

interface HistoryPanelProps {
  open: boolean;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
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
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(false);

  // Load via the background port so we can include live `isRunning` state
  // for each session. The DB itself doesn't know which agents are mid-stream.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const port = chrome.runtime.connect({ name: AGENT_PORT_NAME });
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      setLoading(false);
      try { port.disconnect(); } catch { /* already disconnected */ }
    };
    const onMessage = (msg: ServerMessage) => {
      if (msg.type === 'session_list_result') {
        setSessions(msg.sessions);
        finish();
      } else if (msg.type === 'error') {
        console.warn('[history] session_list error:', msg.error);
        finish();
      }
    };
    port.onMessage.addListener(onMessage);
    port.postMessage({ type: 'session_list' } satisfies ClientMessage);
    // Safety timeout in case the background doesn't respond.
    const timeout = setTimeout(() => {
      console.warn('[history] session_list timed out');
      finish();
    }, 5000);
    return () => {
      clearTimeout(timeout);
      port.onMessage.removeListener(onMessage);
      try { port.disconnect(); } catch { /* already disconnected */ }
      setLoading(false);
    };
  }, [open]);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const session = sessions.find(s => s.id === id);
    if (!session) return;
    const ok = await showConfirm({
      title: t('common.session.deleteConfirmTitle'),
      description: t('common.session.deleteConfirmDescription', [session.title]),
      destructive: true,
      confirmText: t('common.delete'),
    });
    if (!ok) return;
    try {
      // Optimistic UI update
      setSessions(prev => prev.filter(s => s.id !== id));
      onDeleteSession?.(id);
      // Send delete to background (handles DB + agent cleanup)
      const port = chrome.runtime.connect({ name: AGENT_PORT_NAME });
      const onMessage = (msg: ServerMessage) => {
        if (msg.type === 'session_deleted' && msg.sessionId === id) {
          port.onMessage.removeListener(onMessage);
          port.disconnect();
        }
      };
      port.onMessage.addListener(onMessage);
      port.postMessage({ type: 'session_delete', sessionId: id } satisfies ClientMessage);
      // Safety timeout: disconnect after 5s if no response
      setTimeout(() => {
        port.onMessage.removeListener(onMessage);
        try { port.disconnect(); } catch { /* already disconnected */ }
      }, 5000);
    } catch (err) {
      console.error('Failed to delete session:', err);
    }
  };

  return (
    <div
      className={`absolute inset-0 bg-background z-50 flex flex-col transition-transform duration-300 ease-out ${
        open ? 'translate-x-0' : 'translate-x-full'
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border">
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          <ArrowLeft className="size-5" />
        </Button>
        <span className="font-semibold">{t('common.history')}</span>
      </div>

      {/* Body */}
      <ScrollArea className="flex-1">
        <div className="px-5 py-3 space-y-1">
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

          {!loading && sessions.map((session) => (
            <div
              key={session.id}
              role="button"
              tabIndex={0}
              className="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-muted/50 transition-colors group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSelectSession(session.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectSession(session.id); } }}
            >
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
                  <div className="text-sm font-medium truncate min-w-0">
                    {session.title}
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                  {session.model && <span>{session.model}</span>}
                  <span>·</span>
                  <span>{t('common.session.messageCount', session.messageCount)}</span>
                  <span>·</span>
                  <span>{formatRelativeTime(session.updatedAt)}</span>
                </div>
              </div>

              <Button
                variant="ghost"
                size="icon-xs"
                className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0"
                onClick={(e) => handleDelete(e, session.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

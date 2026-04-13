import { useState, useEffect } from 'react';
import { ArrowLeft, Trash2, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { listSessions, type SessionRecord } from '@/lib/db';
import { AGENT_PORT_NAME, type ClientMessage, type ServerMessage } from '@/lib/protocol';

interface HistoryPanelProps {
  open: boolean;
  onClose: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

export function HistoryPanel({ open, onClose, onSelectSession, onDeleteSession }: HistoryPanelProps) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    listSessions()
      .then((result) => {
        setSessions(result);
      })
      .catch((err) => {
        console.error('Failed to load sessions:', err);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open]);

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
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
        <span className="font-semibold">历史记录</span>
      </div>

      {/* Body */}
      <ScrollArea className="flex-1">
        <div className="px-5 py-3 space-y-1">
          {loading && (
            <div className="text-center text-sm text-muted-foreground py-12">
              加载中…
            </div>
          )}

          {!loading && sessions.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <MessageSquare className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">暂无历史记录</p>
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
                <div className="text-sm font-medium truncate">
                  {session.title}
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                  {session.model && <span>{session.model}</span>}
                  <span>·</span>
                  <span>{session.messageCount} 条消息</span>
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

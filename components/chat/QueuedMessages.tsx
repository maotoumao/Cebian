import { ArrowUp, Clock, CornerDownRight, Paperclip, Pencil, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { QueuedPromptView } from '@/lib/ipc/protocol';
import { oneLine } from '@/lib/utils';
import { t } from '@/lib/i18n';

interface QueuedMessagesProps {
  queue: QueuedPromptView[];
  /** 上一轮异常结束，队列不会自动发出。 */
  paused: boolean;
  /** 编辑 / 立即发送这类会改输入框或发消息的操作此刻是否可用（发送上锁中不可用）。 */
  disabled?: boolean;
  onSendNow: (id: string) => void;
  onEdit: (item: QueuedPromptView) => void;
  onRemove: (id: string) => void;
}

/** 一条排队消息的单行预览：没打字只挂了斜杠提示词时显示 `/名字`。 */
function previewText(item: QueuedPromptView): string {
  const text = oneLine(item.text);
  if (!item.slashPromptName) return text;
  return text ? `/${item.slashPromptName} ${text}` : `/${item.slashPromptName}`;
}

/**
 * 输入框上方的排队列表（issue #96）。排队项可立即发送 / 编辑 / 删除；插话中的项已交给
 * agent，只能删除（loop 已取走的删不掉，后台会忽略，等它投进转录后自然消失）。
 */
function QueuedMessages({ queue, paused, disabled, onSendNow, onEdit, onRemove }: QueuedMessagesProps) {
  if (queue.length === 0) return null;
  return (
    <div className="mb-2 space-y-1">
      {paused && <p className="px-1 text-xs text-muted-foreground">{t('chat.composer.queue.paused')}</p>}
      <ul className="max-h-40 space-y-1 overflow-y-auto">
        {queue.map((item) => {
          const steering = item.status === 'steering';
          // 插话中的项旁边有文字状态，图标就不再让读屏重复读一遍
          const StatusIcon = steering ? CornerDownRight : Clock;
          return (
            <li
              key={item.id}
              className="group flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm"
            >
              <StatusIcon
                className={`size-3.5 shrink-0 ${steering ? 'text-primary' : 'text-muted-foreground'}`}
                {...(steering ? { 'aria-hidden': true } : { 'aria-label': t('chat.composer.queue.queued') })}
              />
              <span className="min-w-0 flex-1 truncate" title={item.text}>{previewText(item)}</span>
              {item.attachmentCount > 0 && (
                <span
                  className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
                  title={t('chat.composer.queue.attachmentCount', item.attachmentCount)}
                >
                  <Paperclip className="size-3" />
                  {item.attachmentCount}
                </span>
              )}
              {steering ? (
                <span className="shrink-0 text-xs text-primary">{t('chat.composer.queue.steering')}</span>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="size-6 shrink-0"
                    title={t('chat.composer.queue.sendNow')}
                    aria-label={t('chat.composer.queue.sendNow')}
                    disabled={disabled}
                    onClick={() => onSendNow(item.id)}
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="size-6 shrink-0"
                    title={t('common.edit')}
                    aria-label={t('common.edit')}
                    disabled={disabled}
                    onClick={() => onEdit(item)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-6 shrink-0"
                title={t('common.delete')}
                aria-label={t('common.delete')}
                onClick={() => onRemove(item.id)}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─── 公开 API ───

export { QueuedMessages };

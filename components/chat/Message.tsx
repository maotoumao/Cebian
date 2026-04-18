import { Bot, ChevronRight, Lightbulb, CircleHelp, CheckCircle, Send, Crosshair, FileText } from 'lucide-react';
import { useState, useEffect, useRef, useMemo, type ReactNode, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { extractUserText, extractUserAttachments } from '@/lib/message-helpers';
import { showDialog } from '@/lib/dialog';
import { t } from '@/lib/i18n';
import type { Message } from '@mariozechner/pi-ai';

/* ─── User Message ─── */
export function UserMessageBubble({ msg, children }: { msg?: Message; children?: ReactNode }) {
  const text = msg ? extractUserText(msg) : null;
  const attachments = useMemo(() => msg ? extractUserAttachments(msg) : null, [msg]);
  const hasAttachments = attachments && (attachments.images.length > 0 || attachments.elements.length > 0 || attachments.files.length > 0);

  return (
    <div className="self-end max-w-[95%]">
      <div className="bg-card border border-border px-4 py-3 rounded-2xl text-[0.9rem] leading-relaxed w-fit ml-auto">
        {text ?? children}
      </div>

      {hasAttachments && (
        <div className="flex gap-1.5 flex-wrap items-center justify-end mt-1.5 px-1">
          {attachments.images.map((img, i) => (
            <Badge
              key={`img-${i}`}
              variant="outline"
              className="shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-0.5 pr-1 text-purple-400 border-purple-400/20 bg-purple-400/5"
            >
              <img
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={t('chat.attachments.imageAlt')}
                className="h-3.5 w-auto rounded-sm object-cover cursor-pointer"
                onClick={() => showDialog('image-preview', {
                  src: `data:${img.mimeType};base64,${img.data}`,
                })}
              />
              {t('chat.attachments.image')}
            </Badge>
          ))}
          {attachments.elements.map((el, i) => (
            <Badge
              key={`el-${i}`}
              variant="outline"
              className="shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-1 pr-1 text-info border-info/20 bg-info/5"
            >
              <Crosshair className="size-2.5 shrink-0" />
              <span className="truncate max-w-24">{el.selector}</span>
            </Badge>
          ))}
          {attachments.files.map((f, i) => (
            <Badge
              key={`file-${i}`}
              variant="outline"
              className="shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-1 pr-1 text-emerald-400 border-emerald-400/20 bg-emerald-400/5"
            >
              <FileText className="size-2.5 shrink-0" />
              <span className="truncate max-w-24">{f.name}</span>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Agent Message ─── */
export function AgentMessage({ children, isStreaming, showHeader = true }: { children?: ReactNode; isStreaming?: boolean; showHeader?: boolean }) {
  return (
    <div className={`self-start w-full ${showHeader ? '' : '-mt-1'}`}>
      {showHeader && (
        <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground font-medium">
          <Bot className="size-3.5 text-primary" />
          Cebian Agent
        </div>
      )}
      <div className="text-[0.9rem] leading-relaxed space-y-3">
        {children}
        {isStreaming && !children && (
          <span className="inline-block w-1.5 h-4 bg-primary animate-pulse rounded-sm align-text-bottom" />
        )}
      </div>
    </div>
  );
}

/* ─── Agent Text Block (Markdown) ─── */
export function AgentTextBlock({ content }: { content: string }) {
  return <MarkdownRenderer content={content} />;
}

/* ─── Thinking Block (renders pi-ai ThinkingContent) ─── */
export function ThinkingBlock({ content, isLive }: { content: string; isLive?: boolean }) {
  const [manualOpen, setManualOpen] = useState(false);
  const wasLive = useRef(false);

  // Auto-collapse when transitioning from live to done
  useEffect(() => {
    if (wasLive.current && !isLive) {
      setManualOpen(false);
    }
    wasLive.current = !!isLive;
  }, [isLive]);

  const isOpen = isLive || manualOpen;

  return (
    <div className="border border-border rounded-lg overflow-hidden text-xs bg-card/30">
      <button
        onClick={() => !isLive && setManualOpen(!manualOpen)}
        className="w-full flex items-center gap-2 px-3 py-2 text-muted-foreground font-mono text-[0.75rem] hover:text-foreground hover:bg-card/40 transition-colors"
      >
        <ChevronRight
          className={`size-2.5 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
        />
        <Lightbulb className="size-3 text-primary" />
        {isLive ? 'Thinking...' : 'Thinking Process'}
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-300 ease-in-out ${
          isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        }`}
      >
        <div className="overflow-hidden">
          <div className="px-3 py-3 border-t border-dashed border-border text-muted-foreground font-mono text-[0.75rem] leading-relaxed bg-card/50">
            <MarkdownRenderer content={content} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Ask User Block (interactive tool UI) ─── */
export function AskUserBlock({
  question,
  options,
  allowFreeText = true,
  answered,
  onSelect,
}: {
  question: string;
  options?: { label: string; description?: string }[];
  allowFreeText?: boolean;
  answered?: boolean;
  onSelect?: (text: string) => void;
}) {
  const [freeText, setFreeText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleFreeTextSubmit = () => {
    if (!freeText.trim()) return;
    onSelect?.(freeText.trim());
    setFreeText('');
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleFreeTextSubmit();
    }
  };

  return (
    <div className={`relative mt-3 p-3.5 border border-primary/20 bg-primary/5 rounded-lg ${answered ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-2 text-primary font-medium text-[0.85rem] mb-1.5">
        <CircleHelp className="size-4.5 shrink-0" />
        {question}
      </div>

      {/* Option buttons */}
      {options && options.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2.5">
          {options.map((opt, i) => (
            <Button
              key={`${i}-${opt.label}`}
              variant="outline"
              size="sm"
              className="text-xs h-7"
              disabled={!onSelect}
              onClick={() => onSelect?.(opt.label)}
              title={opt.description}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      )}

      {/* Free text input */}
      {allowFreeText && onSelect && (
        <div className="flex items-end gap-1.5 mt-2.5">
          <textarea
            ref={textareaRef}
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('chat.askUser.placeholder')}
            rows={1}
            className="flex-1 resize-none bg-background border border-border rounded-md px-2.5 py-1.5 text-xs leading-relaxed placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleFreeTextSubmit}
            disabled={!freeText.trim()}
            className="shrink-0"
          >
            <Send className="size-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

/* ─── Execution Success ─── */
export function ExecutionResult({
  message,
  actions,
}: {
  message: string;
  actions?: { label: string; primary?: boolean; onClick?: () => void }[];
}) {
  return (
    <>
      <p className="text-success text-[0.85rem] flex items-center gap-1.5 mt-3">
        <CheckCircle className="size-3.5" />
        {message}
      </p>
      {actions && actions.length > 0 && (
        <div className="flex gap-2 mt-2">
          {actions.map((a) => (
            <Button
              key={a.label}
              variant={a.primary ? 'default' : 'outline'}
              size="sm"
              className="text-xs h-7"
              onClick={a.onClick}
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </>
  );
}

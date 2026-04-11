import { Bot, ChevronRight, Lightbulb, CircleHelp, CheckCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';

/* ─── User Message ─── */
export function UserMessageBubble({ children }: { children: ReactNode }) {
  return (
    <div className="self-end max-w-[95%] animate-in slide-in-from-bottom-2 fade-in duration-300">
      <div className="bg-card border border-border px-4 py-3 rounded-2xl rounded-br-sm text-[0.9rem] leading-relaxed">
        {children}
      </div>
    </div>
  );
}

/* ─── Agent Message ─── */
export function AgentMessage({ children, isStreaming }: { children: ReactNode; isStreaming?: boolean }) {
  return (
    <div className="self-start w-full animate-in slide-in-from-bottom-2 fade-in duration-300">
      <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground font-medium">
        <Bot className="size-[14px] text-primary" />
        Cebian Agent
      </div>
      <div className="text-[0.9rem] leading-relaxed space-y-3">
        {children}
        {isStreaming && (
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
export function ThinkingBlock({ content }: { content: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-border rounded-lg overflow-hidden text-xs bg-card/30">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-muted-foreground font-mono text-[0.75rem] hover:text-foreground hover:bg-card/40 transition-colors"
      >
        <ChevronRight
          className={`size-[10px] transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
        />
        <Lightbulb className="size-3 text-primary" />
        Thinking Process
      </button>
      {open && (
        <div className="px-3 py-3 border-t border-dashed border-border text-muted-foreground font-mono text-[0.75rem] leading-relaxed bg-card/50">
          <MarkdownRenderer content={content} className="prose-xs" />
        </div>
      )}
    </div>
  );
}

/* ─── Clarification Box ─── */
export function ClarificationBox({
  title,
  description,
  options,
  answered,
  onSelect,
}: {
  title: string;
  description: string;
  options: { label: string; primary?: boolean }[];
  answered?: boolean;
  onSelect?: (label: string) => void;
}) {
  return (
    <div className={`relative mt-3 p-3.5 border border-primary/20 bg-primary/5 rounded-lg ${answered ? 'opacity-60' : ''}`}>
      {/* left accent bar */}
      <div className="absolute left-0 top-2.5 bottom-2.5 w-[2px] rounded-r bg-primary shadow-[0_0_8px_var(--primary)]" />

      <div className="flex items-center gap-1.5 text-primary font-medium text-[0.85rem] mb-1.5">
        <CircleHelp className="size-3.5" />
        {title}
      </div>
      <p className="text-xs text-muted-foreground mb-3">{description}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => (
          <Button
            key={opt.label}
            variant={opt.primary ? 'default' : 'outline'}
            size="sm"
            className="text-xs h-7"
            disabled={answered}
            onClick={() => onSelect?.(opt.label)}
          >
            {opt.label}
          </Button>
        ))}
      </div>
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

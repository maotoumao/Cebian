import { useState } from 'react';
import { ChevronRight, Loader2, Check, X } from 'lucide-react';

interface ToolCardProps {
  label: string;
  status: 'running' | 'done' | 'error';
  args: string;
  result?: string;
}

export function ToolCard({ label, status, args, result }: ToolCardProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-border rounded-lg overflow-hidden my-2 text-xs">
      {/* Header — always visible */}
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 bg-card hover:bg-accent/50 transition-colors text-left cursor-pointer"
        onClick={() => setOpen(!open)}
      >
        {/* Status icon */}
        {status === 'running' && (
          <Loader2 className="size-3.5 text-primary animate-spin shrink-0" />
        )}
        {status === 'done' && (
          <Check className="size-3.5 text-success shrink-0" />
        )}
        {status === 'error' && (
          <X className="size-3.5 text-destructive shrink-0" />
        )}

        {/* Label */}
        <span className="flex-1 text-muted-foreground truncate">{label}</span>

        {/* Chevron */}
        <ChevronRight
          className={`size-3.5 text-muted-foreground/50 shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
      </button>

      {/* Expandable body */}
      {open && (
        <div className="border-t border-border">
          {/* Arguments */}
          <div className="px-3 py-2 bg-background">
            <div className="text-[0.65rem] text-muted-foreground/60 mb-1 font-medium">参数</div>
            <pre className="text-muted-foreground whitespace-pre-wrap overflow-x-auto font-mono">
              <code>{args}</code>
            </pre>
          </div>

          {/* Result (if available) */}
          {result && (
            <div className="px-3 py-2 bg-background border-t border-border/50">
              <div className="text-[0.65rem] text-muted-foreground/60 mb-1 font-medium">结果</div>
              <pre className="text-muted-foreground whitespace-pre-wrap overflow-x-auto font-mono max-h-48 overflow-y-auto">
                <code>{result}</code>
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

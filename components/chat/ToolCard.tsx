import { Code } from 'lucide-react';

interface ToolCardProps {
  name: string;
  status: 'running' | 'done' | 'error';
  code: string;
}

export function ToolCard({ name, status, code }: ToolCardProps) {
  return (
    <div className="border border-border rounded-lg overflow-hidden my-3 font-mono text-xs">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-card border-b border-border text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Code className="size-3" />
          {name}
        </span>
        <div className="flex items-center gap-1.5 text-primary">
          {status === 'running' && (
            <>
              <span className="size-3 border-2 border-primary/20 border-t-primary rounded-full animate-spin-slow" />
              <span>Running...</span>
            </>
          )}
          {status === 'done' && <span className="text-success">✓ Done</span>}
          {status === 'error' && <span className="text-destructive">✕ Error</span>}
        </div>
      </div>

      {/* Code body */}
      <div className="p-3 bg-[#0a0a0d] text-[#a9a9b3] overflow-x-auto">
        <pre className="whitespace-pre-wrap">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}

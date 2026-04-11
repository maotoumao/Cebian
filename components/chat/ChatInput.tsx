import { useState, useRef, useEffect, useMemo, type KeyboardEvent } from 'react';
import { Send, Mic, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ModelSelector } from '@/components/settings/model/ModelSelector';
import { ThinkingLevelSelector } from '@/components/settings/model/ThinkingLevelSelector';
import { useStorageItem } from '@/hooks/useStorageItem';
import { activeModel, thinkingLevel, providerCredentials, type ThinkingLevel } from '@/lib/storage';
import { getModel, type KnownProvider } from '@mariozechner/pi-ai';
import { SLASH_COMMANDS } from '@/lib/constants';

interface ChatInputProps {
  onSend: (message: string) => void;
  onOpenSettings?: () => void;
}

export function ChatInput({ onSend, onOpenSettings }: ChatInputProps) {
  const [value, setValue] = useState('');
  const [mode, setMode] = useState<'agent' | 'ask'>('agent');
  const [showSlash, setShowSlash] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [currentModel, setCurrentModel] = useStorageItem(activeModel, null);
  const [currentThinkingLevel, setCurrentThinkingLevel] = useStorageItem(thinkingLevel, 'medium');
  const [providers] = useStorageItem(providerCredentials, {});

  const isReasoningModel = useMemo(() => {
    if (!currentModel) return false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- modelId is dynamic, pi-ai expects string literal
      return (getModel as any)(currentModel.provider, currentModel.modelId)?.reasoning ?? false;
    } catch {
      return false;
    }
  }, [currentModel]);

  const handleModelSelect = (provider: string, modelId: string) => {
    setCurrentModel({ provider, modelId });
  };

  const handleThinkingSelect = (level: ThinkingLevel) => {
    setCurrentThinkingLevel(level);
  };

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 150) + 'px';
    }
  }, [value]);

  const handleSend = () => {
    if (!value.trim()) return;
    onSend(value.trim());
    setValue('');
    setShowSlash(false);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (val: string) => {
    setValue(val);
    setShowSlash(val.startsWith('/'));
  };



  return (
    <footer className="px-4 py-4 border-t border-border bg-background relative">
      {/* Slash menu */}
      {showSlash && (
        <div className="absolute bottom-full left-4 right-4 mb-3 bg-accent border border-border rounded-lg p-1.5 shadow-xl z-50 animate-in slide-in-from-bottom-1 fade-in duration-150">
          {SLASH_COMMANDS.map((cmd) => (
            <button
              key={cmd.name}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-md hover:bg-card transition-colors text-left"
              onClick={() => {
                setValue(cmd.name + ' ');
                setShowSlash(false);
                textareaRef.current?.focus();
              }}
            >
              <span className="text-base w-7 h-7 grid place-items-center rounded bg-card/50">
                {cmd.icon}
              </span>
              <div className="flex flex-col">
                <span className="text-[0.85rem] font-medium font-mono">
                  {cmd.name}
                </span>
                <span className="text-[0.7rem] text-muted-foreground">
                  {cmd.desc}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="border border-border rounded-2xl bg-card focus-within:border-border/80 focus-within:ring-2 focus-within:ring-primary/10 transition-all">
        {/* Top row: context badges + mode */}
        <div className="flex items-center justify-between px-3 pt-2">
          <div className="flex gap-1.5 flex-wrap">
            <Badge
              variant="outline"
              className="text-info border-info/20 bg-info/5 text-[0.7rem] font-mono gap-1 h-5"
            >
              #login-form
              <button className="opacity-70 hover:opacity-100 ml-0.5">✕</button>
            </Badge>
          </div>

          <button
            onClick={() => setMode(mode === 'agent' ? 'ask' : 'agent')}
            className={`flex items-center gap-1 px-2 py-0.5 rounded-md font-mono text-[0.75rem] border transition-colors ${
              mode === 'agent'
                ? 'text-primary border-primary/20 bg-primary/5'
                : 'text-info border-info/20 bg-info/5'
            }`}
          >
            {mode === 'agent' ? '✨ Agent' : '💬 Ask'}
            <ChevronDown className="size-3" />
          </button>
        </div>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type '/' for commands..."
          className="w-full bg-transparent border-none outline-none resize-none text-foreground text-[0.9rem] px-3 py-3 min-h-[48px] max-h-[150px] leading-relaxed placeholder:text-muted-foreground/50"
        />

        {/* Bottom row: actions */}
        <div className="flex items-center justify-between px-2 pb-2">
          <div className="flex items-center gap-1">
            <ModelSelector
              activeModel={currentModel}
              configuredProviders={providers}
              onSelect={handleModelSelect}
              onOpenSettings={onOpenSettings ?? (() => {})}
            />
            {isReasoningModel && (
              <ThinkingLevelSelector
                level={currentThinkingLevel}
                onSelect={handleThinkingSelect}
              />
            )}
          </div>

          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-xs">
              <Mic className="size-4" />
            </Button>

            <button
              onClick={handleSend}
              className="w-8 h-8 rounded-md bg-foreground text-background grid place-items-center hover:bg-primary hover:scale-105 transition-all"
            >
              <Send className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      <p className="text-center text-[0.65rem] text-muted-foreground/50 mt-2.5">
        Cebian has CDP and script injection permissions active.
      </p>
    </footer>
  );
}

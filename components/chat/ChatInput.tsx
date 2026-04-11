import { useState, useRef, useEffect, useMemo, type KeyboardEvent } from 'react';
import { Send, MousePointer2, Camera, Paperclip, Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { ThinkingLevelSelector } from '@/components/chat/ThinkingLevelSelector';
import { useStorageItem } from '@/hooks/useStorageItem';
import { activeModel, thinkingLevel, providerCredentials, customProviders as customProvidersStorage, type ThinkingLevel } from '@/lib/storage';
import { getModel, type KnownProvider } from '@mariozechner/pi-ai';
import { isCustomProvider, findCustomModel, mergeCustomProviders } from '@/lib/custom-models';
import { SLASH_COMMANDS, PRESET_PROVIDERS } from '@/lib/constants';

interface ChatInputProps {
  onSend: (message: string) => void;
  onOpenSettings?: () => void;
}

export function ChatInput({ onSend, onOpenSettings }: ChatInputProps) {
  const [value, setValue] = useState('');
  const [showSlash, setShowSlash] = useState(false);
  const [mobileMode, setMobileMode] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [currentModel, setCurrentModel] = useStorageItem(activeModel, null);
  const [currentThinkingLevel, setCurrentThinkingLevel] = useStorageItem(thinkingLevel, 'medium');
  const [providers] = useStorageItem(providerCredentials, {});
  const [customProviderList] = useStorageItem(customProvidersStorage, []);

  const allCustomProviders = useMemo(() =>
    mergeCustomProviders(PRESET_PROVIDERS, customProviderList),
  [customProviderList]);

  const isReasoningModel = useMemo(() => {
    if (!currentModel) return false;

    if (isCustomProvider(currentModel.provider)) {
      return findCustomModel(allCustomProviders, currentModel.provider, currentModel.modelId)?.reasoning ?? false;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- modelId is dynamic, pi-ai expects string literal
      return (getModel as any)(currentModel.provider, currentModel.modelId)?.reasoning ?? false;
    } catch {
      return false;
    }
  }, [currentModel, allCustomProviders]);

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
        <div className="absolute bottom-full left-4 right-4 mb-3 bg-popover border border-border rounded-lg p-1.5 shadow-xl z-50 animate-in slide-in-from-bottom-1 fade-in duration-150">
          {SLASH_COMMANDS.map((cmd) => (
            <button
              key={cmd.name}
              className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md hover:bg-accent transition-colors text-left cursor-pointer"
              onClick={() => {
                setValue(cmd.name + ' ');
                setShowSlash(false);
                textareaRef.current?.focus();
              }}
            >
              <span className="text-sm w-6 h-6 grid place-items-center rounded bg-accent/50 shrink-0">
                {cmd.icon}
              </span>
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-[0.8rem] font-medium font-mono shrink-0">
                  {cmd.name}
                </span>
                <span className="text-[0.65rem] text-muted-foreground truncate">
                  {cmd.desc}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="border border-border rounded-xl bg-card focus-within:border-border/80 focus-within:ring-2 focus-within:ring-primary/10 transition-all">
        {/* Top row: tools + context */}
        <div className="flex items-center gap-1 px-2 pt-2 pb-2">
          {/* Tool icons */}
          <Button variant="ghost" size="icon-xs" title="选择元素">
            <MousePointer2 className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" title="截图">
            <Camera className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" title="上传文件">
            <Paperclip className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="移动端模式"
            className={mobileMode ? 'bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary' : ''}
            onClick={() => setMobileMode(!mobileMode)}
          >
            <Smartphone className="size-3.5" />
          </Button>

          <Separator orientation="vertical" className="h-4! mx-1 bg-border" />

          {/* Context badges */}
          <div className="flex gap-1 flex-wrap flex-1 min-w-0">
            <Badge
              variant="outline"
              className="text-info border-info/20 bg-info/5 text-[0.65rem] font-mono gap-1 h-4.5 rounded"
            >
              #login-form
              <button className="opacity-70 hover:opacity-100 ml-0.5 text-[0.6rem]">✕</button>
            </Badge>
          </div>
        </div>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type '/' for commands..."
          className="w-full bg-transparent border-none outline-none resize-none text-foreground text-[0.85rem] px-3 py-2 min-h-11 max-h-37.5 leading-relaxed placeholder:text-muted-foreground/50"
        />

        {/* Bottom row: actions */}
        <div className="flex items-center justify-between px-2 pb-1.5">
          <div className="flex items-center gap-0.5">
            <ModelSelector
              activeModel={currentModel}
              configuredProviders={providers}
              customProviders={allCustomProviders}
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
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={handleSend}
              className="bg-foreground text-background hover:bg-primary hover:text-primary-foreground hover:shadow-xs"
            >
              <Send className="size-3" />
            </Button>
          </div>
        </div>
      </div>

      <p className="text-center text-[0.65rem] text-muted-foreground/50 mt-2.5">
        Cebian has CDP and script injection permissions active.
      </p>
    </footer>
  );
}

import { useState, useRef, useEffect, useMemo, useCallback, type KeyboardEvent } from 'react';
import { Send, Square, MousePointer2, Camera, Paperclip, Smartphone, Crosshair, FileText, X, FileType } from 'lucide-react';
import { showDialog } from '@/lib/dialog';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { ThinkingLevelSelector } from '@/components/chat/ThinkingLevelSelector';
import { useStorageItem } from '@/hooks/useStorageItem';
import { activeModel, thinkingLevel, providerCredentials, customProviders as customProvidersStorage, type ThinkingLevel } from '@/lib/storage';
import { getModel } from '@mariozechner/pi-ai';
import { isCustomProvider, findCustomModel, mergeCustomProviders } from '@/lib/custom-models';
import { PRESET_PROVIDERS } from '@/lib/constants';
import { startElementPicker, cancelElementPicker } from '@/lib/element-picker';
import { scanPrompts, type PromptMeta } from '@/lib/ai-config/scanner';
import { replaceTemplateVars, gatherTemplateVars } from '@/lib/ai-config/template';
import { vfs } from '@/lib/vfs';
import { parseFrontmatter } from '@/lib/ai-config/frontmatter';
import { CEBIAN_PROMPTS_DIR } from '@/lib/constants';
import {
  MAX_ATTACHMENT_COUNT, MAX_IMAGE_SIZE, MAX_TEXT_FILE_SIZE,
  isImageFile, isTextFile, formatFileSize,
  type Attachment,
} from '@/lib/attachments';
import { useMobileEmulation } from '@/hooks/useMobileEmulation';

interface ChatInputProps {
  onSend: (message: string, attachments?: Attachment[]) => void;
  onOpenSettings?: () => void;
  isAgentRunning?: boolean;
  onCancel?: () => void;
}

export function ChatInput({ onSend, onOpenSettings, isAgentRunning, onCancel }: ChatInputProps) {
  const [value, setValue] = useState('');
  const [showSlash, setShowSlash] = useState(false);
  const [prompts, setPrompts] = useState<PromptMeta[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isPicking, setIsPicking] = useState(false);
  const { isActiveTabMobile, toggle: toggleMobile } = useMobileEmulation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleModelSelect = useCallback((provider: string, modelId: string) => {
    setCurrentModel({ provider, modelId });
  }, [setCurrentModel]);

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

  // Cancel picker on unmount
  useEffect(() => {
    return () => { cancelElementPicker(); };
  }, []);

  // Cancel picker on Esc key (sidepanel has focus, not the page)
  useEffect(() => {
    if (!isPicking) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelElementPicker();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isPicking]);

  const canSend = value.trim().length > 0;

  const handleSend = () => {
    if (!canSend) return;
    if (!currentModel) {
      toast.error('请先选择一个 AI 模型', {
        action: onOpenSettings ? { label: '前往设置', onClick: onOpenSettings } : undefined,
      });
      return;
    }
    onSend(value.trim(), attachments.length > 0 ? attachments : undefined);
    setValue('');
    setAttachments([]);
    setShowSlash(false);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isAgentRunning) handleSend();
    }
  };

  const handleInput = (val: string) => {
    setValue(val);
    setShowSlash(val.startsWith('/'));
  };

  // Scan prompts when slash menu opens
  useEffect(() => {
    if (!showSlash) return;
    scanPrompts().then(setPrompts).catch(() => setPrompts([]));
  }, [showSlash]);

  // Filter prompts by typed search (after '/')
  const slashFilter = value.startsWith('/') ? value.slice(1).toLowerCase() : '';
  const filteredPrompts = slashFilter
    ? prompts.filter((p) => p.name.toLowerCase().includes(slashFilter) || p.description.toLowerCase().includes(slashFilter))
    : prompts;

  // Handle prompt selection from slash menu
  const handlePromptSelect = async (prompt: PromptMeta) => {
    try {
      const raw = await vfs.readFile(`${CEBIAN_PROMPTS_DIR}/${prompt.fileName}`, 'utf8');
      const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      const { body } = parseFrontmatter(content);
      const vars = await gatherTemplateVars();
      const replaced = replaceTemplateVars(body.trim(), vars);
      setValue(replaced);
      setShowSlash(false);
      textareaRef.current?.focus();
    } catch {
      toast.error('读取 Prompt 失败');
    }
  };

  const handlePickElement = async () => {
    if (isPicking) {
      cancelElementPicker();
      return;
    }
    setIsPicking(true);
    try {
      const result = await startElementPicker();
      if (result) {
        // Deduplicate: same selector + same frameId
        const isDuplicate = attachments.some(
          (a) => a.type === 'element' && a.selector === result.selector && a.frameId === result.frameId,
        );
        if (isDuplicate) {
          toast.info('该元素已添加');
        } else {
          setAttachments((prev) => [...prev, result]);
        }
      }
    } catch (err) {
      toast.error('元素选择失败');
      console.error('[Element Picker]', err);
    } finally {
      setIsPicking(false);
      textareaRef.current?.focus();
    }
  };

  const handleScreenshot = async () => {
    if (attachments.length >= MAX_ATTACHMENT_COUNT) {
      toast.warning(`最多添加 ${MAX_ATTACHMENT_COUNT} 个附件`);
      return;
    }
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 85 });
      const base64 = dataUrl.split(',', 2)[1] ?? '';
      setAttachments((prev) => [
        ...prev,
        { type: 'image', source: 'screenshot', data: base64, mimeType: 'image/jpeg' },
      ]);
    } catch (err) {
      toast.error('截图失败');
      console.error('[Screenshot]', err);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const remaining = MAX_ATTACHMENT_COUNT - attachments.length;
    if (remaining <= 0) {
      toast.warning(`最多添加 ${MAX_ATTACHMENT_COUNT} 个附件`);
      e.target.value = '';
      return;
    }

    const filesToProcess = Array.from(files).slice(0, remaining);
    if (files.length > remaining) {
      toast.warning(`仅添加前 ${remaining} 个文件，已达上限`);
    }

    for (const file of filesToProcess) {
      if (isImageFile(file)) {
        if (file.size > MAX_IMAGE_SIZE) {
          toast.error(`${file.name} 超过 ${formatFileSize(MAX_IMAGE_SIZE)} 限制`);
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(',', 2)[1] ?? '';
          const mimeType = file.type || 'image/png';
          setAttachments((prev) => {
            if (prev.length >= MAX_ATTACHMENT_COUNT) return prev;
            return [...prev, { type: 'image', source: 'upload', data: base64, mimeType, name: file.name }];
          });
        };
        reader.onerror = () => toast.error(`读取失败: ${file.name}`);
        reader.readAsDataURL(file);
      } else if (isTextFile(file.name)) {
        if (file.size > MAX_TEXT_FILE_SIZE) {
          toast.error(`${file.name} 超过 ${formatFileSize(MAX_TEXT_FILE_SIZE)} 限制`);
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          setAttachments((prev) => {
            if (prev.length >= MAX_ATTACHMENT_COUNT) return prev;
            return [...prev, { type: 'file', content: reader.result as string, name: file.name, mimeType: file.type || 'text/plain', size: file.size }];
          });
        };
        reader.onerror = () => toast.error(`读取失败: ${file.name}`);
        reader.readAsText(file);
      } else {
        toast.error(`不支持的文件类型: ${file.name}`);
      }
    }

    // Reset input so the same file can be selected again
    e.target.value = '';
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <footer className="px-4 py-4 border-t border-border bg-background relative">
      {/* Slash menu — dynamic VFS prompts */}
      {showSlash && (
        <div className="absolute bottom-full left-4 right-4 mb-3 bg-popover border border-border rounded-lg shadow-xl z-50 animate-in slide-in-from-bottom-1 fade-in duration-150 max-h-60 overflow-y-auto">
          {filteredPrompts.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3 px-2.5">
              {prompts.length === 0 ? '暂无 Prompt，前往 AI 配置创建' : '无匹配结果'}
            </p>
          ) : (
            <div className="py-1">
              {filteredPrompts.map((p) => (
                <button
                  key={p.fileName}
                  onClick={() => handlePromptSelect(p)}
                  className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-accent/50 transition-colors"
                >
                  <FileType className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">/{p.name}</p>
                    {p.description && (
                      <p className="text-xs text-muted-foreground truncate">{p.description}</p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="border border-border rounded-xl bg-card focus-within:border-border/80 focus-within:ring-2 focus-within:ring-primary/10 transition-all">
        {/* Top row: tools + attachments */}
        <div className="flex items-center gap-1 px-2 pt-2 pb-2">
          {/* Tool icons */}
          <Button
            variant="ghost"
            size="icon-xs"
            title={isPicking ? '取消选择' : '选择元素'}
            onClick={handlePickElement}
            className={isPicking ? 'bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary' : ''}
          >
            <MousePointer2 className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" title="截图" onClick={handleScreenshot}>
            <Camera className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-xs" title="上传文件" onClick={() => fileInputRef.current?.click()}>
            <Paperclip className="size-3.5" />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.txt,.md,.csv,.tsv,.log,.js,.ts,.jsx,.tsx,.mjs,.cjs,.py,.java,.c,.cpp,.h,.hpp,.go,.rs,.rb,.php,.sh,.bash,.sql,.yaml,.yml,.toml,.ini,.cfg,.json,.xml,.html,.htm,.css,.scss,.less,.env,.gitignore,.editorconfig"
            className="hidden"
            onChange={handleFileUpload}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            title="移动端模式"
            className={isActiveTabMobile ? 'bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary' : ''}
            onClick={toggleMobile}
          >
            <Smartphone className="size-3.5" />
          </Button>

          {attachments.length > 0 && (
            <>
              <Separator orientation="vertical" className="h-4! mx-1 bg-border" />

              {/* Attachment chips */}
              <div className="flex gap-1.5 flex-1 min-w-0 overflow-x-auto scrollbar-none items-center">
                {attachments.map((att, i) => (
                  att.type === 'image' ? (
                    // Image attachment: thumbnail + label badge
                    <Badge
                      key={i}
                      variant="outline"
                      className="shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-0.5 pr-0.5 text-purple-400 border-purple-400/20 bg-purple-400/5 group"
                    >
                      <img
                        src={`data:${att.mimeType};base64,${att.data}`}
                        alt={att.name || '截图'}
                        className="h-3.5 w-5 rounded-sm object-cover cursor-pointer"
                        onClick={() => showDialog('image-preview', {
                          src: `data:${att.mimeType};base64,${att.data}`,
                          alt: att.name || '截图',
                        })}
                      />
                      <span className="truncate max-w-24">
                        {att.name || (att.source === 'screenshot' ? '截图' : '图片')}
                      </span>
                      <button
                        className="opacity-60 hover:opacity-100 p-0.5 rounded-sm hover:bg-foreground/10 cursor-pointer"
                        onClick={() => removeAttachment(i)}
                      >
                        <X className="size-2.5" />
                      </button>
                    </Badge>
                  ) : (
                    // Element / file attachment: badge chip
                    <Badge
                      key={i}
                      variant="outline"
                      className={`shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-1 pr-0.5 ${
                        att.type === 'element'
                          ? 'text-info border-info/20 bg-info/5'
                          : 'text-emerald-400 border-emerald-400/20 bg-emerald-400/5'
                      }`}
                    >
                      {att.type === 'element' && <Crosshair className="size-2.5 shrink-0" />}
                      {att.type === 'file' && <FileText className="size-2.5 shrink-0" />}

                      <span className="truncate max-w-24">
                        {att.type === 'element' && att.selector}
                        {att.type === 'file' && att.name}
                      </span>

                      <button
                        className="opacity-60 hover:opacity-100 p-0.5 rounded-sm hover:bg-foreground/10 cursor-pointer"
                        onClick={() => removeAttachment(i)}
                      >
                        <X className="size-2.5" />
                      </button>
                    </Badge>
                  )
                ))}
              </div>
            </>
          )}
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
            {isAgentRunning ? (
              <Button
                variant="destructive"
                size="icon-xs"
                onClick={() => onCancel?.()}
                className="hover:shadow-xs"
              >
                <Square className="size-3" fill="currentColor" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleSend}
                disabled={!canSend}
                className="bg-foreground text-background hover:bg-primary hover:text-primary-foreground hover:shadow-xs disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Send className="size-3" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </footer>
  );
}

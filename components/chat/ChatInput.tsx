import { useState, useRef, useEffect, useMemo, useCallback, useImperativeHandle, forwardRef, type KeyboardEvent } from 'react';
import { Send, Square, MousePointer2, Camera, Paperclip, Smartphone, Crosshair, FileText, X, FileType, Film } from 'lucide-react';
import { showDialog } from '@/lib/ui/dialog';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { ThinkingLevelSelector } from '@/components/chat/ThinkingLevelSelector';
import { RecordButton } from '@/components/chat/RecordButton';
import { MicButton } from '@/components/chat/MicButton';
import { useStorageItem } from '@/hooks/useStorageItem';
import { providerCredentials, customProviders as customProvidersStorage, type ThinkingLevel, type ModelIdentity } from '@/lib/persistence/storage';
import { getModel } from '@earendil-works/pi-ai';
import { isCustomProvider, findCustomModel } from '@/lib/providers/custom-models';
import { startElementPicker, cancelElementPicker } from '@/lib/browser/element-picker';
import { scanPrompts, type PromptMeta } from '@/lib/ai-config/scanner';
import { replaceTemplateVars, gatherTemplateVars } from '@/lib/ai-config/template';
import { vfs } from '@/lib/persistence/vfs';
import { parseFrontmatter } from '@/lib/content/frontmatter';
import { CEBIAN_PROMPTS_DIR } from '@/lib/persistence/vfs-paths';
import {
  MAX_ATTACHMENT_COUNT, MAX_IMAGE_SIZE, MAX_TEXT_FILE_SIZE,
  RECORDING_MIME,
  isImageFile, isTextFile, formatFileSize,
  type Attachment,
} from '@/lib/agent/attachments';
import { recordingToAttachment } from '@/lib/recorder/to-attachment';
import { recorderChannel } from '@/lib/recorder/sidepanel-channel';
import { useRecorder } from '@/hooks/useRecorder';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { appendTranscript, cleanTranscript } from '@/lib/speech/transcript';
import { queryMicPermission, openMicPermissionPage, openSystemMicSettings } from '@/lib/speech/mic-permission';
import { useMobileEmulation } from '@/hooks/useMobileEmulation';
import { downloadFile, formatDuration, formatCharCount } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { PromptDispatchResult } from '@/hooks/useBackgroundAgent';

interface ChatInputProps {
  onSend: (
    message: string,
    attachments: Attachment[] | undefined,
    expectedSessionId: string | null,
  ) => Promise<PromptDispatchResult>;
  onOpenSettings?: () => void;
  isAgentRunning?: boolean;
  onCancel?: () => void;
  /** User-message texts already sent in this session, oldest first. */
  userHistory?: string[];
  /** Conversation id; changing it resets history navigation state. */
  sessionId?: string | null;
  /** 本轮选中的模型 / 思考档（受控）。由 ChatPage 持有：新对话从全局种子 seed、
   *  已有会话从会话行 seed；切换走 onModelChange / onThinkingChange。 */
  model: ModelIdentity | null;
  thinkingLevel: ThinkingLevel;
  onModelChange: (model: ModelIdentity) => void;
  onThinkingChange: (level: ThinkingLevel) => void;
}

/** 暴露给父组件的 imperative handle：允许欢迎页等外部入口填入文本并聚焦输入框，
 *  同时仍由 ChatInput 持有 value 状态。 */
export interface ChatInputHandle {
  fill: (text: string) => void;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  { onSend, onOpenSettings, isAgentRunning, onCancel, userHistory, sessionId, model: currentModel, thinkingLevel: currentThinkingLevel, onModelChange, onThinkingChange },
  ref,
) {
  const [value, setValue] = useState('');
  const [showSlash, setShowSlash] = useState(false);
  const [prompts, setPrompts] = useState<PromptMeta[]>([]);
  const [selectedPromptIndex, setSelectedPromptIndex] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Mirror of `attachments` for synchronous reads after an await. The
  // recorder's `subscribeSession` callback fires synchronously when the
  // BG delivers a session, but React state isn't flushed by the time
  // `await recorder.stop()` resumes — so we keep this ref so handleSend
  // can read the post-stop attachment list without waiting for a render.
  const attachmentsRef = useRef<Attachment[]>([]);
  const [isPicking, setIsPicking] = useState(false);
  // History navigation: null = editing the current draft; otherwise points
  // into `userHistory`. `draft` stashes whatever the user had typed before
  // entering history mode so we can restore it on ↓-past-end.
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const { isActiveTabMobile, toggle: toggleMobile } = useMobileEmulation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef<string | null>(sessionId ?? null);
  sessionIdRef.current = sessionId ?? null;

  const [providers] = useStorageItem(providerCredentials, {});
  const [customProviderList] = useStorageItem(customProvidersStorage, []);

  const isReasoningModel = useMemo(() => {
    if (!currentModel) return false;

    if (isCustomProvider(currentModel.provider)) {
      return findCustomModel(customProviderList, currentModel.provider, currentModel.modelId)?.reasoning ?? false;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- modelId is dynamic, pi-ai expects string literal
      return (getModel as any)(currentModel.provider, currentModel.modelId)?.reasoning ?? false;
    } catch {
      return false;
    }
  }, [currentModel, customProviderList]);

  // 当前模型是否支持图片（多模态/VLM）输入。统一读 pi-ai Model.input 是否包含 'image'：
  // 自定义模型的 input 由 toModel 根据 image 字段生成，内置模型由 getModel 提供。
  const supportsImage = useMemo(() => {
    if (!currentModel) return false;

    if (isCustomProvider(currentModel.provider)) {
      return findCustomModel(customProviderList, currentModel.provider, currentModel.modelId)?.input?.includes('image') ?? false;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- modelId is dynamic, pi-ai expects string literal
      return (getModel as any)(currentModel.provider, currentModel.modelId)?.input?.includes('image') ?? false;
    } catch {
      return false;
    }
  }, [currentModel, customProviderList]);

  // 异步图片生产者（截图 await、FileReader.onload）可能在用户切换到纯文本
  // 模型之后才回调，用 ref 同步读取最新的 supportsImage，避免迟到的图片被追加。
  const supportsImageRef = useRef(supportsImage);
  supportsImageRef.current = supportsImage;

  // 切换到不支持图片的模型时，自动剥离已有的图片附件（保留文件附件），
  // 避免把图片发给纯文本模型导致请求异常。
  useEffect(() => {
    if (supportsImage) return;
    setAttachments((prev) => {
      if (!prev.some((a) => a.type === 'image')) return prev;
      toast.info(t('chat.composer.imageStripped'));
      return prev.filter((a) => a.type !== 'image');
    });
  }, [supportsImage]);

  const handleModelSelect = useCallback((provider: string, modelId: string) => {
    onModelChange({ provider, modelId });
  }, [onModelChange]);

  const handleThinkingSelect = (level: ThinkingLevel) => {
    onThinkingChange(level);
  };

  // ─── 语音输入（本地优先、云端兜底的语音识别）──────────────────────
  // hook 持有在 ChatInput 这一层（而非 MicButton 内），因为识别结果要写进本
  // 输入框。
  //
  // 设计（「直接改 input」）：interim 直接作为 value 末尾的「未定稿后缀」写进
  // 真实 value——输入框始终可编辑（不 readOnly、不屏蔽键盘）。
  //
  // 两个 ref 保证正确：
  //  - interimSuffixRef：当前挂在 value 末尾的未定稿后缀（含补的空格），下一段
  //    interim/final 到来时按其长度精确剥掉再追加。
  //  - lastSpeechValueRef：上次由语音写入的完整 value。若当前 value 与之不等，
  //    说明用户/历史/斜杠菜单等外部路径改了 value——此时不剥旧后缀，直接以当前
  //    value 为新 base 往后追加，绝不删用户内容（符合「编辑时说话是用户自己的
  //    事」，且保证无数据丢失）。
  const valueRef = useRef(value);
  valueRef.current = value;
  const interimSuffixRef = useRef('');
  const lastSpeechValueRef = useRef(value);

  // 计算本次语音写入的 base：value 自上次语音写入后被外部改动 → 以当前 value 为
  // base（不剥后缀）；否则按已知后缀长度精确剥掉。
  const speechBase = (): string => {
    const cur = valueRef.current;
    // 外部改过 value（用户/历史/斜杠菜单），丢弃旧后缀跟踪，以当前 value 为 base。
    if (cur !== lastSpeechValueRef.current) return cur;
    const suffixLen = interimSuffixRef.current.length;
    return suffixLen > 0 ? cur.slice(0, cur.length - suffixLen) : cur;
  };

  const writeSpeechValue = (next: string, suffix: string) => {
    interimSuffixRef.current = suffix;
    lastSpeechValueRef.current = next;
    valueRef.current = next;
    setValue(next);
    setHistoryIndex(null);
  };

  // 实时中间结果：以当前 base 追加最新 interim 预览。
  const handleInterim = useCallback((interimRaw: string) => {
    const base = speechBase();
    const next = appendTranscript(base, interimRaw);
    writeSpeechValue(next, next.slice(base.length));
  }, []);

  // 每段 final（已清洗 + 经 correctTranscript）：以当前 base 追加正式文本，清空后缀。
  const commitTranscript = useCallback((text: string) => {
    const base = speechBase();
    const next = appendTranscript(base, text);
    writeSpeechValue(next, '');
  }, []);

  // 把当前未定稿的 interim 后缀就地清洗定稿，返回定稿后的文本。用于停止 / 发送
  // 前，确保「正在说的那句」不丢、且 CJK 空格被清掉。
  const finalizePendingInterim = useCallback((): string => {
    if (!interimSuffixRef.current) return valueRef.current;
    const base = speechBase();
    const finalized = appendTranscript(base, cleanTranscript(interimSuffixRef.current));
    writeSpeechValue(finalized, '');
    return finalized;
  }, []);

  // 归一化错误 → toast / 引导。`not-allowed` 兜底处理「query 返回 unknown 后
  // 实际未授权」的情况：打开授权页。
  const handleSpeechError = useCallback((kind: string) => {
    switch (kind) {
      case 'not-allowed':
        toast.info(t('chat.composer.voiceNeedPermission'));
        openMicPermissionPage();
        break;
      case 'language-unavailable':
        toast.error(t('chat.composer.voiceLanguageUnavailable'));
        break;
      case 'no-speech':
        toast.info(t('chat.composer.voiceNoSpeech'));
        break;
      case 'audio-capture':
        toast.error(t('chat.composer.voiceAudioCapture'));
        break;
      // network：云端识别连不上（如国内云端被墙 / 断网）——给网络专属提示。
      case 'network':
        toast.error(t('chat.composer.voiceNetworkFailed'));
        break;
      // unknown：无法归类，通用失败提示。
      case 'unknown':
        toast.error(t('chat.composer.voiceFailed'));
        break;
      // aborted 不会经此上报；其余忽略。
      default:
        break;
    }
  }, []);

  const speech = useSpeechRecognition({
    onInterim: handleInterim,
    onFinal: commitTranscript,
    onError: handleSpeechError,
  });

  const speechActive = speech.state === 'listening' || speech.state === 'preparing';

  // 点击麦克风：听写中→定稿当前 interim 并停止；否则按授权态决定直接听写 /
  // 开授权页 / 开设置页。
  const handleMicClick = useCallback(async () => {
    if (speechActive) {
      finalizePendingInterim();
      speech.stop();
      return;
    }
    const perm = await queryMicPermission();
    if (perm === 'granted' || perm === 'unknown') {
      // unknown：无法探测，乐观尝试；若实际未授权，识别会回 not-allowed 走引导。
      void speech.start();
      return;
    }
    if (perm === 'denied') {
      toast.error(t('chat.composer.voiceDenied'));
      openSystemMicSettings();
      return;
    }
    // prompt：尚未授权，打开授权页让用户在普通标签页完成一次授权。
    toast.info(t('chat.composer.voiceNeedPermission'));
    openMicPermissionPage();
  }, [speechActive, finalizePendingInterim, speech]);

  // Auto-resize textarea. When the value is empty (initial mount, after
  // send) we clear the inline height entirely and let CSS `min-h-11 /
  // max-h-37.5` drive sizing. This avoids a first-paint race in the
  // sidepanel where `scrollHeight` is read before fonts / Tailwind / the
  // first layout pass have stabilized — in that window the textarea is
  // measured against browser defaults and can report a height >= 150,
  // which then gets clamped to 150px and frozen as inline style until the
  // user types the first character.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!value) {
      el.style.height = '';
      return;
    }
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
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

  // Recorder integration. The captured session lands in attachments via
  // the channel subscription below — NOT via `recorder.stop()`'s return
  // value. handleSend just needs to await stop() so any in-flight session
  // delivery completes before we read attachments.
  const recorder = useRecorder();
  // Guard the short dispatch window: recorder finalization plus prompt
  // delivery / one fast reconnect retry. Once the prompt is dispatched,
  // the composer becomes editable again while the agent replies.
  const isDispatchingRef = useRef(false);
  const [isDispatching, setIsDispatching] = useState(false);

  // Keep the ref in sync with state so any post-await reader sees the
  // most-recent attachments without depending on a re-render.
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // Subscribe to recorder sessions delivered by the background. Fires for
  // every finished recording (manual stop button, send-time auto-stop,
  // cap-trigger), so this is the single sink for recording attachments.
  //
  // We compute the next list from `attachmentsRef.current` and write
  // BOTH the ref and the state SYNCHRONOUSLY — NOT inside a
  // `setAttachments(prev => ...)` updater. React 18 defers the updater's
  // execution until the next flush, but `useRecorder.stop()`'s await
  // resumption is a microtask scheduled at the same publishSession call,
  // so by the time handleSend reads `attachmentsRef.current` the updater
  // hasn't run yet. Writing the ref outside the updater ensures handleSend
  // sees the new chip before dispatching `onSend`.
  useEffect(() => {
    return recorderChannel.subscribeSession((session) => {
      console.log('[recorder] session finalized', {
        eventCount: session.events.length,
        durationMs: session.durationMs,
        truncated: session.truncated,
        windowId: session.windowId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        session,
      });
      const current = attachmentsRef.current;
      if (current.length >= MAX_ATTACHMENT_COUNT) {
        toast.warning(t('chat.composer.maxAttachments', [MAX_ATTACHMENT_COUNT]));
        return;
      }
      const next = [...current, recordingToAttachment(session)];
      attachmentsRef.current = next;
      setAttachments(next);
    });
  }, []);

  const handleSend = async () => {
    if (!canSend) return;
    if (isDispatchingRef.current) return;
    if (!currentModel) {
      toast.error(t('chat.composer.needModel'), {
        action: onOpenSettings ? { label: t('chat.composer.goToSettings'), onClick: onOpenSettings } : undefined,
      });
      return;
    }

    // 发送前停止听写并把当前未定稿的 interim 就地清洗定稿，确保「正在说的那句」
    // 一并发出、且 CJK 空格被清掉。
    let outgoingText = value;
    if (speechActive) {
      outgoingText = finalizePendingInterim();
      speech.stop();
    }

    // Snapshot the text BEFORE any await so a fast follow-up edit doesn't
    // leak into the outgoing message.
    const text = outgoingText.trim();
    const dispatchSessionId = sessionIdRef.current;

    isDispatchingRef.current = true;
    setIsDispatching(true);

    try {
      if (recorder.isOwner) {
        // Pre-flight cap check: refuse to send if attachments are already
        // full — otherwise the about-to-be-delivered recording would be
        // silently dropped by the session subscription's overflow guard.
        if (attachmentsRef.current.length >= MAX_ATTACHMENT_COUNT) {
          toast.warning(t('chat.composer.maxAttachments', [MAX_ATTACHMENT_COUNT]));
          return;
        }
        // Wait for the BG to finalize. The session is delivered (and
        // appended to `attachmentsRef`) synchronously by the channel
        // subscription above before this await resolves.
        await recorder.stop();
      }
      if (sessionIdRef.current !== dispatchSessionId) return;

      const outgoing = attachmentsRef.current;
      const result = await onSend(text, outgoing.length > 0 ? outgoing : undefined, dispatchSessionId);
      if (result.status !== 'dispatched') return;
      if (sessionIdRef.current !== dispatchSessionId) return;

      setValue('');
      setAttachments([]);
      attachmentsRef.current = [];
      setShowSlash(false);
      setHistoryIndex(null);
      setDraft('');
    } finally {
      isDispatchingRef.current = false;
      setIsDispatching(false);
    }
  };

  // Reset history navigation when switching sessions. Also stop any active
  // dictation and drop the pending interim tracking so a late final from the
  // previous session can't append into the new session's composer
  // （speech.stop 在空闲时是无副作用的 no-op）。
  useEffect(() => {
    setHistoryIndex(null);
    setDraft('');
    interimSuffixRef.current = '';
    speech.stop();
  }, [sessionId, speech.stop]);

  const handleKeyDown = (e: KeyboardEvent) => {
    // Don't intercept anything while the IME is composing (e.g. Chinese pinyin).
    if (e.nativeEvent.isComposing) return;

    // Slash menu keyboard navigation. Only active while the menu is actually
    // rendered with at least one selectable item — when it's hidden (no
    // match) all keys fall through to the default textarea behaviour
    // (history nav, send, etc.).
    if (isSlashMenuVisible && filteredPrompts.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedPromptIndex((i) => (i + 1) % filteredPrompts.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedPromptIndex((i) => (i - 1 + filteredPrompts.length) % filteredPrompts.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const target = filteredPrompts[selectedPromptIndex] ?? filteredPrompts[0];
        if (target) handlePromptSelect(target);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlash(false);
        return;
      }
    }

    // ↑ / ↓ navigate previously sent user messages, but only when the caret
    // is at the absolute start (↑) or end (↓) of the textarea, so multi-line
    // editing is never disturbed. The slash command menu (when visible)
    // reserves these keys for its own use; once it's hidden — including the
    // "no match" case — history navigation resumes.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !isSlashMenuVisible && userHistory && userHistory.length > 0) {
      const ta = textareaRef.current;
      if (ta) {
        // After history navigation, place the caret to keep further presses
        // ergonomic: ↑ leaves caret at start so the next ↑ keeps walking back;
        // ↓ leaves caret at end so the next ↓ keeps walking forward (and
        // typing continues from where the user is most likely to edit).
        const moveCursor = (where: 'start' | 'end') => {
          requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (!el) return;
            const pos = where === 'end' ? el.value.length : 0;
            el.setSelectionRange(pos, pos);
          });
        };

        if (e.key === 'ArrowUp' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
          if (historyIndex === null) {
            e.preventDefault();
            setDraft(ta.value);
            const last = userHistory.length - 1;
            setHistoryIndex(last);
            setValue(userHistory[last]);
            moveCursor('start');
            return;
          }
          if (historyIndex > 0) {
            e.preventDefault();
            const next = historyIndex - 1;
            setHistoryIndex(next);
            setValue(userHistory[next]);
            moveCursor('start');
            return;
          }
          // Already at oldest entry — fall through.
        }

        if (
          e.key === 'ArrowDown'
          && historyIndex !== null
          && ta.selectionStart === ta.value.length
          && ta.selectionEnd === ta.value.length
        ) {
          e.preventDefault();
          if (historyIndex < userHistory.length - 1) {
            const next = historyIndex + 1;
            setHistoryIndex(next);
            setValue(userHistory[next]);
          } else {
            setHistoryIndex(null);
            setValue(draft);
          }
          moveCursor('end');
          return;
        }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isAgentRunning && !isDispatching) handleSend();
    }
  };

  const handleInput = (val: string) => {
    setValue(val);
    setShowSlash(val.startsWith('/'));
    // Manual edits exit history mode — the new content becomes the draft.
    if (historyIndex !== null) setHistoryIndex(null);
  };

  // 由外部（欢迎页示例卡片）填入文本并聚焦，不夺走输入框对 value 的所有权。
  const fill = useCallback((text: string) => {
    setValue(text);
    setShowSlash(text.startsWith('/'));
    setHistoryIndex(null);
    // 等 value 提交后再聚焦并把光标移到末尾，方便用户接着改。
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);

  useImperativeHandle(ref, () => ({ fill }), [fill]);

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

  // Menu hides when the user has typed a search term that matches nothing —
  // in that case Enter falls through to send the literal `/xxx` text.
  // When the search is empty we keep the menu open even if there are no
  // prompts at all, so the user sees the "no prompts yet" empty state.
  const isSlashMenuVisible = showSlash && (slashFilter === '' || filteredPrompts.length > 0);

  // Clamp the highlighted index whenever the visible list changes.
  useEffect(() => {
    if (filteredPrompts.length === 0) {
      setSelectedPromptIndex(0);
      return;
    }
    setSelectedPromptIndex((i) => Math.min(Math.max(i, 0), filteredPrompts.length - 1));
  }, [filteredPrompts.length]);

  // Reset highlight to the top whenever the menu (re)opens.
  useEffect(() => {
    if (isSlashMenuVisible) setSelectedPromptIndex(0);
  }, [isSlashMenuVisible]);

  // Keep the highlighted item in view when navigating with the keyboard.
  useEffect(() => {
    if (!isSlashMenuVisible) return;
    const el = slashMenuRef.current?.querySelector<HTMLElement>(`[data-prompt-index="${selectedPromptIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedPromptIndex, isSlashMenuVisible]);

  // Handle prompt selection from slash menu
  const handlePromptSelect = async (prompt: PromptMeta) => {
    if (isDispatchingRef.current) return;
    try {
      const raw = await vfs.readFile(`${CEBIAN_PROMPTS_DIR}/${prompt.fileName}`, 'utf8');
      const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      const { body } = parseFrontmatter(content);
      const vars = await gatherTemplateVars();
      const replaced = replaceTemplateVars(body.trim(), vars);
      if (isDispatchingRef.current) return;
      setValue(replaced);
      setShowSlash(false);
      textareaRef.current?.focus();
    } catch {
      toast.error(t('chat.composer.readPromptFailed'));
    }
  };

  const handlePickElement = async () => {
    if (isDispatchingRef.current) return;
    if (isPicking) {
      cancelElementPicker();
      return;
    }
    setIsPicking(true);
    try {
      const result = await startElementPicker();
      if (isDispatchingRef.current) return;
      switch (result.status) {
        case 'ok': {
          const att = result.attachment;
          // Deduplicate: same selector + same frameId
          const isDuplicate = attachments.some(
            (a) => a.type === 'element' && a.selector === att.selector && a.frameId === att.frameId,
          );
          if (isDuplicate) {
            toast.info(t('chat.composer.elementAdded'));
          } else if (attachments.length >= MAX_ATTACHMENT_COUNT) {
            toast.warning(t('chat.composer.maxAttachments', [MAX_ATTACHMENT_COUNT]));
          } else {
            setAttachments((prev) => [...prev, att]);
          }
          break;
        }
        case 'cancelled':
          break;
        case 'error':
          if (result.reason === 'unsupported-page') {
            toast.warning(t('chat.composer.elementPickUnsupported'));
          } else if (result.reason === 'navigation') {
            toast.warning(t('chat.composer.elementPickNavigated'));
          } else {
            toast.error(t('chat.composer.elementPickFailed'));
            if (result.message) console.error('[Element Picker]', result.message);
          }
          break;
      }
    } catch (err) {
      toast.error(t('chat.composer.elementPickFailed'));
      console.error('[Element Picker]', err);
    } finally {
      setIsPicking(false);
      textareaRef.current?.focus();
    }
  };

  const handleScreenshot = async () => {
    if (isDispatchingRef.current) return;
    // 纯文本模型不支持截图（图片）输入，按钮也会被禁用，这里再兜底一次。
    if (!supportsImage) {
      toast.warning(t('chat.composer.modelNoImage'));
      return;
    }
    if (attachments.length >= MAX_ATTACHMENT_COUNT) {
      toast.warning(t('chat.composer.maxAttachments', [MAX_ATTACHMENT_COUNT]));
      return;
    }
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 85 });
      if (isDispatchingRef.current) return;
      if (!supportsImageRef.current) return;
      const base64 = dataUrl.split(',', 2)[1] ?? '';
      setAttachments((prev) => [
        ...prev,
        { type: 'image', source: 'screenshot', data: base64, mimeType: 'image/jpeg' },
      ]);
    } catch (err) {
      toast.error(t('chat.composer.screenshotFailed'));
      console.error('[Screenshot]', err);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isDispatchingRef.current) {
      e.target.value = '';
      return;
    }
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const remaining = MAX_ATTACHMENT_COUNT - attachments.length;
    if (remaining <= 0) {
      toast.warning(t('chat.composer.maxAttachments', [MAX_ATTACHMENT_COUNT]));
      e.target.value = '';
      return;
    }

    const filesToProcess = Array.from(files).slice(0, remaining);
    if (files.length > remaining) {
      toast.warning(t('chat.composer.truncatedFiles', [remaining]));
    }

    for (const file of filesToProcess) {
      if (isImageFile(file)) {
        // 当前模型不支持多模态时，跳过图片文件（文本文件仍照常处理）。
        if (!supportsImage) {
          toast.warning(t('chat.composer.modelNoImage'));
          continue;
        }
        if (file.size > MAX_IMAGE_SIZE) {
          toast.error(t('chat.composer.fileTooLarge', [file.name, formatFileSize(MAX_IMAGE_SIZE)]));
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          if (isDispatchingRef.current) return;
          if (!supportsImageRef.current) return;
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(',', 2)[1] ?? '';
          const mimeType = file.type || 'image/png';
          setAttachments((prev) => {
            if (prev.length >= MAX_ATTACHMENT_COUNT) return prev;
            return [...prev, { type: 'image', source: 'upload', data: base64, mimeType, name: file.name }];
          });
        };
        reader.onerror = () => toast.error(t('chat.composer.readFileFailed', [file.name]));
        reader.readAsDataURL(file);
      } else if (isTextFile(file.name)) {
        if (file.size > MAX_TEXT_FILE_SIZE) {
          toast.error(t('chat.composer.fileTooLarge', [file.name, formatFileSize(MAX_TEXT_FILE_SIZE)]));
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          if (isDispatchingRef.current) return;
          setAttachments((prev) => {
            if (prev.length >= MAX_ATTACHMENT_COUNT) return prev;
            return [...prev, { type: 'file', content: reader.result as string, name: file.name, mimeType: file.type || 'text/plain', size: file.size }];
          });
        };
        reader.onerror = () => toast.error(t('chat.composer.readFileFailed', [file.name]));
        reader.readAsText(file);
      } else {
        toast.error(t('chat.composer.unsupportedFileType', [file.name]));
      }
    }

    // Reset input so the same file can be selected again
    e.target.value = '';
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (isDispatchingRef.current) return;
    // 纯文本模型不接受粘贴的图片，直接放行默认粘贴行为。
    if (!supportsImage) return;
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;

    const imageFiles: File[] = [];
    let hasPlainText = false;
    for (const item of Array.from(items)) {
      if (item.kind === 'string' && item.type === 'text/plain') {
        hasPlainText = true;
      } else if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) imageFiles.push(f);
      }
    }

    if (imageFiles.length === 0) return;
    // Suppress default paste unless there's a real text/plain payload —
    // many screenshot tools also put text/html (filename / <img>) which we don't want in the textarea.
    if (!hasPlainText) e.preventDefault();

    const remaining = MAX_ATTACHMENT_COUNT - attachments.length;
    if (remaining <= 0) {
      toast.warning(t('chat.composer.maxAttachments', [MAX_ATTACHMENT_COUNT]));
      return;
    }

    const filesToProcess = imageFiles.slice(0, remaining);
    if (imageFiles.length > remaining) {
      toast.warning(t('chat.composer.truncatedFiles', [remaining]));
    }

    for (const file of filesToProcess) {
      if (file.size > MAX_IMAGE_SIZE) {
        toast.error(t('chat.composer.fileTooLarge', [file.name || 'image', formatFileSize(MAX_IMAGE_SIZE)]));
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (isDispatchingRef.current) return;
        if (!supportsImageRef.current) return;
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(',', 2)[1] ?? '';
        const mimeType = file.type || 'image/png';
        setAttachments((prev) => {
          if (prev.some((a) => a.type === 'image' && a.data === base64)) {
            // When the user pasted text, the image is likely a side-effect of selecting
            // rich content — silently skip instead of nagging.
            if (!hasPlainText) toast.info(t('chat.composer.imageAlreadyAdded'));
            return prev;
          }
          if (prev.length >= MAX_ATTACHMENT_COUNT) return prev;
          return [...prev, { type: 'image', source: 'paste', data: base64, mimeType, name: file.name || undefined }];
        });
      };
      reader.onerror = () => toast.error(t('chat.composer.readFileFailed', [file.name || 'image']));
      reader.readAsDataURL(file);
    }
  };

  const removeAttachment = (index: number) => {
    if (isDispatchingRef.current) return;
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <footer className="px-4 py-4 border-t border-border bg-background relative">
      {/* Slash menu — dynamic VFS prompts */}
      {isSlashMenuVisible && (
        <div
          ref={slashMenuRef}
          className="absolute bottom-full left-4 right-4 mb-3 bg-popover border border-border rounded-lg shadow-xl z-50 animate-in slide-in-from-bottom-1 fade-in duration-150 max-h-60 overflow-y-auto"
        >
          {filteredPrompts.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3 px-2.5">
              {t('chat.composer.noPrompts')}
            </p>
          ) : (
            <div className="py-1">
              {filteredPrompts.map((p, idx) => {
                const selected = idx === selectedPromptIndex;
                return (
                  <button
                    key={p.fileName}
                    data-prompt-index={idx}
                    disabled={isDispatching}
                    onClick={() => handlePromptSelect(p)}
                    onMouseMove={() => { if (!isDispatching) setSelectedPromptIndex(idx); }}
                    className={`w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors ${selected ? 'bg-accent' : 'hover:bg-accent/50'}`}
                  >
                    <FileType className="size-4 mt-0.5 shrink-0 text-muted-foreground" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">/{p.name}</p>
                      {p.description && (
                        <p className="text-xs text-muted-foreground truncate">{p.description}</p>
                      )}
                    </div>
                  </button>
                );
              })}
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
            title={isPicking ? t('chat.composer.cancelPick') : t('chat.composer.pickElement')}
            onClick={handlePickElement}
            disabled={isDispatching}
            className={isPicking ? 'bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary' : ''}
          >
            <MousePointer2 className="size-3.5" />
          </Button>
          <RecordButton disabled={isDispatching} />
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                // span 包裹：按钮 disabled 时本身不接收指针事件，靠外层 span 触发 tooltip。
                className="inline-flex"
              >
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={handleScreenshot}
                  disabled={isDispatching || !supportsImage}
                >
                  <Camera className="size-3.5" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {supportsImage ? t('chat.composer.screenshot') : t('chat.composer.modelNoImage')}
            </TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="icon-xs" title={t('chat.composer.uploadFile')} onClick={() => fileInputRef.current?.click()} disabled={isDispatching}>
            <Paperclip className="size-3.5" />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={`${supportsImage ? 'image/*,' : ''}.txt,.md,.csv,.tsv,.log,.js,.ts,.jsx,.tsx,.mjs,.cjs,.py,.java,.c,.cpp,.h,.hpp,.go,.rs,.rb,.php,.sh,.bash,.sql,.yaml,.yml,.toml,.ini,.cfg,.json,.xml,.html,.htm,.css,.scss,.less,.env,.gitignore,.editorconfig`}
            className="hidden"
            disabled={isDispatching}
            onChange={handleFileUpload}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            title={t('chat.composer.mobileMode')}
            className={isActiveTabMobile ? 'bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary' : ''}
            onClick={toggleMobile}
            disabled={isDispatching}
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
                        alt={att.name || t('chat.attachments.screenshot')}
                        className="h-3.5 w-5 rounded-sm object-cover cursor-pointer"
                        onClick={() => showDialog('image-preview', {
                          src: `data:${att.mimeType};base64,${att.data}`,
                          alt: att.name || t('chat.attachments.screenshot'),
                        })}
                      />
                      <span className="truncate max-w-24">
                        {att.name || (att.source === 'screenshot' ? t('chat.attachments.screenshot') : t('chat.attachments.image'))}
                      </span>
                      <button
                        className="opacity-60 hover:opacity-100 p-0.5 rounded-sm hover:bg-foreground/10 cursor-pointer"
                        disabled={isDispatching}
                        onClick={() => removeAttachment(i)}
                      >
                        <X className="size-2.5" />
                      </button>
                    </Badge>
                  ) : att.type === 'recording' ? (
                    // Recording attachment: amber chip mirroring Message.tsx;
                    // chip body downloads the JSON, X removes from the list.
                    <Badge
                      key={i}
                      variant="outline"
                      className="shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-1 pr-0.5 text-amber-400 border-amber-400/20 bg-amber-400/5 hover:bg-amber-400/10"
                      title={`${t('chat.attachments.recordingDownload')}\n${t('chat.attachments.recordingHover', [String(att.eventCount), formatCharCount(att.json.length)])}`}
                    >
                      <button
                        className="flex items-center gap-1 cursor-pointer"
                        onClick={() => downloadFile(att.name, att.json, RECORDING_MIME)}
                      >
                        <Film className="size-2.5 shrink-0" />
                        <span className="truncate max-w-40">
                          {att.name} · {t('chat.attachments.recordingMeta', [String(att.eventCount), formatDuration(att.durationMs)])}
                        </span>
                      </button>
                      <button
                        className="opacity-60 hover:opacity-100 p-0.5 rounded-sm hover:bg-foreground/10 cursor-pointer"
                        disabled={isDispatching}
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
                        disabled={isDispatching}
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
          rows={1}
          value={value}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={t('chat.composer.placeholder')}
          disabled={isDispatching}
          className="w-full bg-transparent border-none outline-none resize-none text-foreground text-[0.85rem] px-3 py-2 min-h-11 max-h-37.5 leading-relaxed placeholder:text-muted-foreground/50"
        />

        {/* Bottom row: actions */}
        <div className="flex items-center justify-between px-2 pb-1.5">
          <div className={`flex items-center gap-0.5 ${isDispatching ? 'pointer-events-none opacity-60' : ''}`}>
            <ModelSelector
              activeModel={currentModel}
              configuredProviders={providers}
              customProviders={customProviderList}
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
            {speech.supported && (
              <MicButton
                state={speech.state}
                onClick={() => { void handleMicClick(); }}
                disabled={isDispatching}
              />
            )}
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
                disabled={!canSend || isDispatching}
                aria-label={t('common.send')}
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
});

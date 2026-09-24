import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, useImperativeHandle, forwardRef, type KeyboardEvent } from 'react';
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
import { ContextUsageIndicator } from '@/components/chat/ContextUsageIndicator';
import { useStorageItem } from '@/hooks/useStorageItem';
import { providerCredentials, customProviders as customProvidersStorage, type ThinkingLevel, type ModelIdentity } from '@/lib/persistence/storage';
import type { ContextUsage } from '@/lib/ipc/protocol';
import { getSupportedThinkingLevels, clampThinkingLevel } from '@earendil-works/pi-ai';
import { resolveModel } from '@/lib/providers/resolve-model';
import { isUsableModel } from '@/lib/providers/usable-models';
import { startElementPicker, cancelElementPicker } from '@/lib/browser/element-picker';
import { scanPrompts, type PromptMeta } from '@/lib/ai-config/scanner';
import { replaceTemplateVars } from '@/lib/ai-config/template';
import { gatherTemplateVars } from '@/lib/ai-config/template-vars-sidepanel';
import type { SlashPrompt } from '@/lib/ai-config/slash-prompt';
import { vfs } from '@/lib/persistence/vfs';
import { parseFrontmatter } from '@/lib/content/frontmatter';
import { CEBIAN_PROMPTS_DIR } from '@/lib/persistence/vfs-paths';
import {
  MAX_ATTACHMENT_COUNT, MAX_IMAGE_SIZE, MAX_TEXT_FILE_SIZE,
  RECORDING_MIME,
  isImageFile, isTextFile,
  type Attachment,
} from '@/lib/agent/attachments';
import { recordingToAttachment } from '@/lib/recorder/to-attachment';
import { recorderChannel } from '@/lib/recorder/sidepanel-channel';
import { useRecorder } from '@/hooks/useRecorder';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { appendTranscript, cleanTranscript } from '@/lib/speech/transcript';
import { openPermissionPage, openPermissionSettings, queryPermission } from '@/lib/ui/user-permission';
import { useMobileEmulation } from '@/hooks/useMobileEmulation';
import { useChatAppearance } from '@/hooks/useChatAppearance';
import { downloadFile, formatDuration, formatCompactCount, formatBytes } from '@/lib/utils';
import { t } from '@/lib/i18n';
import type { PromptDispatchResult } from '@/hooks/useBackgroundAgent';

interface ChatInputProps {
  onSend: (
    message: string,
    attachments: Attachment[] | undefined,
    expectedSessionId: string | null,
    slashPrompt: SlashPrompt | undefined,
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
  /** 当前上下文占用；`null`（还没收到后台快照）时不渲染占用环。 */
  contextUsage: ContextUsage | null;
}

/** 暴露给父组件的 imperative handle：允许欢迎页等外部入口填入文本并聚焦输入框，
 *  同时仍由 ChatInput 持有 value 状态。 */
export interface ChatInputHandle {
  fill: (text: string) => void;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  { onSend, onOpenSettings, isAgentRunning, onCancel, userHistory, sessionId, model: currentModel, thinkingLevel: currentThinkingLevel, onModelChange, onThinkingChange, contextUsage },
  ref,
) {
  const [value, setValue] = useState('');
  const [showSlash, setShowSlash] = useState(false);
  // 本轮挂着的斜杠提示词。选中 `/x` 不把正文倒进输入框，而是在输入框首行左端挂一枚
  // `/名字` 标记，正文在发送时自成信封里的一段，不掺进用户自己敲的话（issue #53）。
  // 标记是独立元素、不是文本：因此它天然不可分割——选区碰不到它、光标进不去，
  // 也就不需要任何「从文本里认出它」的解析。
  const [slashPrompt, setSlashPrompt] = useState<SlashPrompt | null>(null);
  // 标记的实测宽度。textarea 的 `text-indent` 只缩进首行，用它给标记让出位置，
  // 文字便从标记右侧接着流，换行后第二行自动回到整宽。
  const slashPillRef = useRef<HTMLSpanElement>(null);
  const [slashPillWidth, setSlashPillWidth] = useState(0);
  // 只用来触发重新测量高度：字号 / 字体变了，行数与行高随之变，但 value 一个字没动
  const appearance = useChatAppearance();
  // 选中一条提示词要 await 读 VFS + 采集模板变量（页面脚本注入、剪贴板），期间用户可能
  // 已经切了会话、又点了另一条、把已挂的标记退格摘掉，或者干脆已经把消息发出去了。
  // 这四处都自增，选中落定前比对世代号，过期的结果直接丢弃。
  const slashPromptSeqRef = useRef(0);
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

  // 当前模型解析成 pi-ai Model（内置 + 自定义统一走 resolveModel）。是否支持图片 /
  // 支持哪些思考档 等能力派生共用这一次解析，避免多份内联解析各自漂移
  const resolvedModel = useMemo(
    () => (currentModel ? resolveModel(currentModel, providers, customProviderList) : null),
    [currentModel, providers, customProviderList],
  );

  // 选中的模型是否还选得出来。`resolveModel` 不看凭据（凭据被删也照样解析成功），因此
  // 不能拿它当门禁——发送前的拦截与 ModelSelector 的失效标记共用 `isUsableModel`
  // 这一个判据（issue #62）。
  const modelUsable = useMemo(
    () => !!currentModel && isUsableModel(currentModel, providers, customProviderList),
    [currentModel, providers, customProviderList],
  );

  // 当前模型支持的思考档：pi 按模型 thinkingLevelMap 推导（非推理模型只返回 ['off']），
  // 多于一档可选时才显示选择器。存的档位可能超出当前模型上限（切到弱模型）→ 夹进支持集
  // 仅供高亮显示、不改全局偏好（切回强模型仍恢复）；后台派发时对同一模型做同样的 clamp，
  // 故显示与实际发出一致
  const thinkingLevels = useMemo(
    () => (resolvedModel ? getSupportedThinkingLevels(resolvedModel) : []),
    [resolvedModel],
  );
  const displayThinkingLevel = resolvedModel
    ? clampThinkingLevel(resolvedModel, currentThinkingLevel)
    : currentThinkingLevel;

  // 当前模型是否支持图片（多模态/VLM）输入：读 pi-ai Model.input 是否含 'image'
  const supportsImage = resolvedModel?.input?.includes('image') ?? false;

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
        void openPermissionPage('microphone').then((opened) => {
          if (opened) toast.info(t('chat.composer.voiceNeedPermission'));
        });
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
    const perm = await queryPermission('microphone');
    if (perm === 'granted' || perm === 'unknown') {
      // unknown：无法探测，乐观尝试；若实际未授权，识别会回 not-allowed 走引导。
      void speech.start();
      return;
    }
    if (perm === 'denied') {
      void openPermissionSettings('microphone').then((opened) => {
        if (opened) toast.error(t('chat.composer.voiceDenied'));
      });
      return;
    }
    // prompt：尚未授权，打开授权页让用户在普通标签页完成一次授权。
    void openPermissionPage('microphone').then((opened) => {
      if (opened) toast.info(t('chat.composer.voiceNeedPermission'));
    });
  }, [speechActive, finalizePendingInterim, speech]);

  /** 输入框滚动时把标记一并带走。它绝对定位在容器上、不跟随文本滚动，不同步就会
   *  浮在原地压住滚上来的第二屏文字。外层的 `overflow-hidden` 负责裁掉溢出部分。 */
  const syncSlashPillOffset = useCallback(() => {
    const pill = slashPillRef.current;
    const ta = textareaRef.current;
    if (pill && ta) pill.style.transform = `translateY(${-ta.scrollTop}px)`;
  }, []);

  // Auto-resize textarea. When the value is empty (initial mount, after
  // send) we clear the inline height entirely and let CSS `min-h-13 /
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
    // 高度变了 scrollTop 可能被浏览器悄悄改掉（且不发 scroll 事件），补一次同步。
    syncSlashPillOffset();
    // 也要盯着 `slashPillWidth`：标记挂上/摘掉会改变 `text-indent`，首行随之重排、
    // 行数可能变，但 value 一个字都没动——只看 value 的话高度就停在旧值上了。
    // `appearance` 同理：在设置里调字号 / 字体时输入框里可能正留着草稿。
  }, [value, slashPillWidth, syncSlashPillOffset, appearance]);

  // 标记宽度只能实测：提示词名字的长度、界面字体、侧边栏宽度（`max-w-[45%]` 截断）
  // 都会改变它，写死任何常量都会让首行文字与标记错位。ResizeObserver 覆盖字体加载
  // 完成、侧边栏拖宽这些迟到的变化。
  useLayoutEffect(() => {
    const pill = slashPillRef.current;
    if (!pill) {
      setSlashPillWidth(0);
      return;
    }
    // +6px：标记与正文之间的呼吸位。
    const measure = () => {
      setSlashPillWidth(Math.ceil(pill.getBoundingClientRect().width) + 6);
      syncSlashPillOffset();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pill);
    return () => observer.disconnect();
  }, [slashPrompt?.name, syncSlashPillOffset]);

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

  // 只挂了提示词、一个字没打也算可发——提示词本身就是这一轮的请求。
  const canSend = value.trim().length > 0 || slashPrompt !== null;

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
    // 没选模型 → 引导去选；选了但已失效（下架 / 凭据被删）→ 说明原因并让用户重选。
    // 在这里拦住，用户输入的文案就还留在输入框里，不会因为后台 throw 而白打一遍。
    if (!currentModel || !modelUsable) {
      toast.error(currentModel ? t('errors.modelUnavailable') : t('chat.composer.needModel'), {
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
    // 作废在途的提示词选中。只靠 stillCurrent() 里那个 isDispatchingRef 快照不够：
    // 一整轮发送完全可能在选中的 await 窗口内起止（gatherTemplateVars 要注入页面脚本、
    // 读剪贴板，比一次纯文本发送慢得多），等选中落定时该标志已经变回 false，那条被
    // 放弃的提示词就会重新挂上，抹掉用户已经在写的下一条消息并抢走焦点。
    slashPromptSeqRef.current++;

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
      const result = await onSend(text, outgoing.length > 0 ? outgoing : undefined, dispatchSessionId, slashPrompt ?? undefined);
      if (result.status !== 'dispatched') return;
      if (sessionIdRef.current !== dispatchSessionId) return;

      setValue('');
      setAttachments([]);
      attachmentsRef.current = [];
      setSlashPrompt(null);
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
    setSlashPrompt(null);
    slashPromptSeqRef.current++;
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

    // 光标停在最前面再按退格 = 摘掉挂着的提示词。标记就在文字前面，「往前删」删到的
    // 正是它——与 ChatGPT / Claude 的 pill 一致。整块摘除是唯一的粒度，因为它压根
    // 不是文本，没有「删掉一半」这回事。
    if (e.key === 'Backspace' && slashPrompt) {
      const ta = textareaRef.current;
      if (ta && ta.selectionStart === 0 && ta.selectionEnd === 0) {
        e.preventDefault();
        setSlashPrompt(null);
        slashPromptSeqRef.current++;
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

        // 翻历史只换文本，不动挂着的提示词：「这一轮带什么指令」与「这一轮说什么话」
        // 是两件事。外部 `fill()` 同理。
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

  /** 聚焦输入框并把光标移到末尾。value 是受控的，得等这一次提交渲染完再设光标。 */
  const focusCaretAtEnd = useCallback(() => {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);

  // 由外部（欢迎页示例卡片）填入文本并聚焦，不夺走输入框对 value 的所有权。
  const fill = useCallback((text: string) => {
    setValue(text);
    setShowSlash(text.startsWith('/'));
    setHistoryIndex(null);
    // 等 value 提交后再聚焦并把光标移到末尾，方便用户接着改。
    focusCaretAtEnd();
  }, [focusCaretAtEnd]);

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
    const seq = ++slashPromptSeqRef.current;
    const selectedSessionId = sessionIdRef.current;
    // 选中那一刻输入框里的内容（就是用来筛选的 `/xxx`）。落定时按它剥前缀，
    // 等待期间接着敲进去的话必须原样留下。
    const queryAtSelect = value;
    // 结果落定时仍是同一个会话、且没有更晚的选中把它顶掉，才允许写入。
    const stillCurrent = () =>
      !isDispatchingRef.current
      && slashPromptSeqRef.current === seq
      && sessionIdRef.current === selectedSessionId;
    try {
      const raw = await vfs.readFile(`${CEBIAN_PROMPTS_DIR}/${prompt.fileName}`, 'utf8');
      const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      const { body } = parseFrontmatter(content);
      const vars = await gatherTemplateVars();
      // 模板变量在**选中的这一刻**展开：挂上去的正文就是最终会发出去的文本。
      const replaced = replaceTemplateVars(body.trim(), vars);
      if (!stillCurrent()) return;
      setSlashPrompt({ name: prompt.name, body: replaced });
      // 清掉用来筛选的那截 `/xxx`——它的使命结束了，提示词已经挂成标记。
      // 读 VFS + 采集模板变量是个不短的 await，期间用户完全可能接着往下敲，
      // 那些字是他要发的正文，一个都不能抹掉。
      setValue((v) => {
        if (v.startsWith(queryAtSelect)) return v.slice(queryAtSelect.length).replace(/^[ \t]+/, '');
        // 等待期间把筛选词自己改短 / 改乱了：仍按「开头那截非空白」当筛选词剥掉。
        if (v.startsWith('/')) return v.replace(/^\/\S*/, '').replace(/^[ \t]+/, '');
        return v;
      });
      setShowSlash(false);
      focusCaretAtEnd();
    } catch {
      if (stillCurrent()) toast.error(t('chat.composer.readPromptFailed'));
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
          toast.error(t('chat.composer.fileTooLarge', [file.name, formatBytes(MAX_IMAGE_SIZE)]));
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
          toast.error(t('chat.composer.fileTooLarge', [file.name, formatBytes(MAX_TEXT_FILE_SIZE)]));
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
        toast.error(t('chat.composer.fileTooLarge', [file.name || 'image', formatBytes(MAX_IMAGE_SIZE)]));
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
        <div className="flex items-center gap-0.5 px-2.5 pt-2.5 pb-2">
          {/* Tool icons */}
          <Button
            variant="ghost"
            size="icon-xs"
            title={isPicking ? t('chat.composer.cancelPick') : t('chat.composer.pickElement')}
            onClick={handlePickElement}
            disabled={isDispatching}
            className={`size-7 ${isPicking ? 'bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary' : ''}`}
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
                  className="size-7"
                >
                  <Camera className="size-3.5" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {supportsImage ? t('chat.composer.screenshot') : t('chat.composer.modelNoImage')}
            </TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="icon-xs" title={t('chat.composer.uploadFile')} onClick={() => fileInputRef.current?.click()} disabled={isDispatching} className="size-7">
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
            className={`size-7 ${isActiveTabMobile ? 'bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary' : ''}`}
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
                      title={`${t('chat.attachments.recordingDownload')}\n${t('chat.attachments.recordingHover', [String(att.eventCount), formatCompactCount(att.json.length)])}`}
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

        {/* Textarea + slash prompt pill.
          * 标记绝对定位在首行左端，textarea 用 `text-indent` 给它让出首行的位置；
          * 外层 `overflow-hidden` 负责在输入框滚动时把它裁掉。
          */}
        <div className="relative overflow-hidden">
          {slashPrompt && (
            <span
              ref={slashPillRef}
              // `top-2 / left-3` 对齐 textarea 的 `py-2 / px-3`；字号行高与首行文字
              // 完全一致，标记的盒高因此正好是一个行框，天然坐在首行上。
              // `max-w-[45%]` 保证名字再长，首行也总还有地方写字。
              className="pointer-events-none absolute top-2 left-3 max-w-[45%] truncate rounded-md bg-primary/10 px-1.5 font-mono chat-text-input leading-relaxed text-primary"
            >
              /{slashPrompt.name}
            </span>
          )}
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={(e) => handleInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onScroll={syncSlashPillOffset}
            placeholder={t('chat.composer.placeholder')}
            disabled={isDispatching}
            style={slashPrompt && slashPillWidth ? { textIndent: slashPillWidth } : undefined}
            className="w-full bg-transparent border-none outline-none resize-none text-foreground chat-text-input chat-font px-3 py-2 min-h-13 max-h-37.5 leading-relaxed placeholder:text-muted-foreground/50"
          />
        </div>

        {/* Bottom row: actions */}
        <div className="flex items-center justify-between px-2 pb-1.5">
          <div className={`flex items-center gap-0.5 ${isDispatching ? 'pointer-events-none opacity-60' : ''}`}>
            <ModelSelector
              activeModel={currentModel}
              configuredProviders={providers}
              customProviders={customProviderList}
              onSelect={handleModelSelect}
              showAddModels
            />
            {thinkingLevels.length > 1 && (
              <ThinkingLevelSelector
                level={displayThinkingLevel}
                levels={thinkingLevels}
                onSelect={handleThinkingSelect}
              />
            )}
          </div>

          <div className="flex items-center gap-1">
            <ContextUsageIndicator usage={contextUsage} />
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
                className="size-7 hover:shadow-xs"
              >
                <Square className="size-3.5" fill="currentColor" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={handleSend}
                disabled={!canSend || isDispatching}
                aria-label={t('common.send')}
                className="size-7 bg-foreground text-background hover:bg-primary hover:text-primary-foreground hover:shadow-xs disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Send className="size-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </footer>
  );
});

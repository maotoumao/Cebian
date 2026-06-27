import { Bot, ChevronRight, Lightbulb, CircleHelp, CheckCircle, Send, Crosshair, FileText, Film, FoldVertical, ShieldAlert } from 'lucide-react';
import { useState, useEffect, useRef, useMemo, type ReactNode, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { MarkdownRenderer } from '@/components/common/MarkdownRenderer';
import { MessageMetaRow, type MessageMetaProps } from '@/components/chat/MessageMetaRow';
import { extractUserText, extractUserAttachments } from '@/lib/agent/message-helpers';
import { showDialog } from '@/lib/ui/dialog';
import { RECORDING_MIME } from '@/lib/agent/attachments';
import { t } from '@/lib/i18n';
import { describePermission } from '@/lib/agent/tool-permissions';
import { downloadFile, formatDuration, formatCharCount } from '@/lib/utils';
import { FormBlock } from '@/components/chat/FormBlock';
import { normalizeRequest } from '@/lib/tools/ask-user';
import type { Message } from '@earendil-works/pi-ai';

/* ─── User Message ─── */
export function UserMessageBubble({ msg, children }: { msg?: Message; children?: ReactNode }) {
  const text = msg ? extractUserText(msg) : null;
  const attachments = useMemo(() => msg ? extractUserAttachments(msg) : null, [msg]);
  const hasAttachments = attachments && (attachments.images.length > 0 || attachments.elements.length > 0 || attachments.files.length > 0 || attachments.recordings.length > 0);

  return (
    <div className="self-end max-w-[95%]">
      <div className="bg-card border border-border px-4 py-3 rounded-2xl text-[0.9rem] leading-relaxed w-fit ml-auto whitespace-pre-wrap break-all">
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
          {attachments.recordings.map((r, i) => (
            <Badge
              key={`rec-${i}`}
              variant="outline"
              className="shrink-0 text-[0.65rem] font-mono gap-1 h-5 rounded pl-1 pr-1 text-amber-400 border-amber-400/20 bg-amber-400/5 cursor-pointer hover:bg-amber-400/10"
              title={`${t('chat.attachments.recordingDownload')}\n${t('chat.attachments.recordingHover', [String(r.eventCount), formatCharCount(r.json.length)])}`}
              onClick={() => downloadFile(r.name, r.json, RECORDING_MIME)}
            >
              <Film className="size-2.5 shrink-0" />
              <span className="truncate max-w-40">
                {r.name} · {t('chat.attachments.recordingMeta', [String(r.eventCount), formatDuration(r.durationMs)])}
                {r.truncated ? ` · ${t('chat.attachments.recordingTruncated')}` : ''}
              </span>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Compaction Divider ─── */
/** 历史压缩分割条：标记此处之前的上下文已被折叠成摘要——发送给模型时只保留
 *  摘要，但原始消息仍完整留在消息流里供用户向上翻阅。静态、不可折叠。
 *  注：压缩前 token 估算已暂时隐藏（仍存于 compactionSummary.tokensBefore），
 *  将来可能恢复展示。 */
export function CompactionDivider() {
  return (
    <div className="flex items-center gap-2 my-1 select-none" role="separator">
      <div className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground/70 font-medium whitespace-nowrap">
        <FoldVertical className="size-3 shrink-0" />
        {t('chat.compaction.divider')}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

/* ─── Compaction Placeholder ─── */
/** 压缩进行中的占位消息：压缩是发送前的一次独立 LLM 调用，期间复用
 *  普通的 Cebian Agent 消息外壳 + 一行灰色斜体「正在压缩」，让它看起来就是
 *  agent 这一轮在忙。压缩结束后 isCompacting 转 false、本条消失，由真实输出顶上；
 *  压缩中点停止则与普通取消一致——用户气泡保留、其下显示「已取消」（后台
 *  commitCompactionCancel 补一条 aborted 标记），本占位随 isCompacting 转 false 消失。 */
export function CompactionPlaceholder() {
  return (
    <AgentMessage>
      <span className="text-xs italic text-muted-foreground/80">{t('chat.compaction.status')}</span>
    </AgentMessage>
  );
}

/* ─── Agent Message ─── */

/**
 * 把消息的「回复正文」转成「所见即所读」的纯文本，供朗读使用。内容容器里除了
 * 回复正文，还夹杂着 thinking 块、工具卡片、错误/取消提示等不该朝读的块；故采
 * 用 opt-in：只读打了 `data-speech-content` 标记的回复正文（AgentTextBlock）子树，
 * 新增的其它块默认不会被读。未找到标记时回退到整个容器（防御性）。
 *
 * react-markdown 渲染后的 DOM 已脱去 Markdown 语法，`textContent` 即用户看到的
 * 文字，无需正则反解。代码块（`<pre>` 及其外层容器，含语言标签 + 复制按钮）
 * 不逐字朗读——克隆节点后整体替换成一句「已略过」提示，含语言时报出语言名
 * （首字母大写）。
 */
function extractSpeakText(el: HTMLElement | null): string {
  if (!el) return '';
  const clone = el.cloneNode(true) as HTMLElement;
  // 只取回复正文子树；缺失时退回整个内容容器。
  const target = clone.querySelector<HTMLElement>('[data-speech-content]') ?? clone;
  for (const pre of Array.from(target.querySelectorAll('pre'))) {
    const langClass = Array.from(pre.querySelector('code')?.classList ?? [])
      .find((c) => c.startsWith('language-'));
    const lang = langClass ? langClass.slice('language-'.length) : '';
    const label = lang ? lang.charAt(0).toUpperCase() + lang.slice(1) : '';
    const notice = label
      ? t('common.speakCodeSkipped', [label])
      : t('common.speakCodeSkippedPlain');
    // 代码块容器是 <pre> 的父节点（CodeBlock 的外层 div，含头部语言标签 + 复制
    // 按钮）；整体替换掉，避免把代码和「Code」标签也念出来。两端补句末标点，让这
    // 句提示成为独立、完整的一句——否则 speechSynthesis 会按内部逗号把它拆成「黏
    // 上文的前半句 + 黏下文的后半句」，听不出这里是跳过（标点是断句结构，归提取
    // 逻辑管，不放进 locale 文案）。
    const period = /[\u4e00-\u9fff]/.test(notice) ? '。' : '. ';
    const container = pre.parentElement ?? pre;
    container.replaceWith(document.createTextNode(`${period}${notice}${period}`));
  }
  return (target.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function AgentMessage({
  children,
  isStreaming,
  showHeader = true,
  meta,
  copyText,
  onRetry,
}: {
  children?: ReactNode;
  isStreaming?: boolean;
  showHeader?: boolean;
  /** Meta is rendered as soon as `!isStreaming`; the copy button inside the
   * row is gated on `copyText` (skipped for pure tool-call turns). */
  meta?: Omit<MessageMetaProps, 'text' | 'onRetry'>;
  copyText?: string;
  /** When provided, a retry button is shown in the meta row. Caller decides
   *  eligibility (last turn-closing assistant, agent idle). */
  onRetry?: () => void;
}) {
  // 朗读按钮惰性读取这个容器的 DOM 文本（见 extractSpeakText），避免提前求值。
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <div className={`self-start w-full ${showHeader ? '' : '-mt-1'}`}>
      {showHeader && (
        <div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground font-medium">
          <Bot className="size-3.5 text-primary" />
          Cebian Agent
        </div>
      )}
      <div ref={contentRef} className="text-[0.9rem] leading-relaxed space-y-3">
        {children}
        {isStreaming && (
          <span
            aria-hidden
            className="inline-block w-1.5 h-4 bg-primary animate-pulse rounded-sm align-text-bottom ml-0.5"
          />
        )}
      </div>
      {!isStreaming && (meta || copyText || onRetry) && (
        <MessageMetaRow
          {...(meta ?? {})}
          text={copyText}
          getSpeakText={() => extractSpeakText(contentRef.current)}
          onRetry={onRetry}
        />
      )}
    </div>
  );
}

/* ─── Agent Text Block (Markdown) ─── */
export function AgentTextBlock({ content }: { content: string }) {
  // data-speech-content：标记「可朗读的回复正文」，供 extractSpeakText 只读此子树，
  // 从而跳过 thinking / 工具卡片 / 错误提示等同处一个容器下的其它块。
  return (
    <div data-speech-content>
      <MarkdownRenderer content={content} />
    </div>
  );
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

/* ─── Shared option button ─── */
// 交互卡片（AskUserBlock / PermissionRequestBlock）共用的小号选项按钮。
// `selected` 用 default 实心高亮表达「这个选项被选中了」（权限卡片决策后用），
// AskUserBlock 不传 selected 即普通 outline 按钮。
function PromptOptionButton({
  label,
  description,
  selected,
  disabled,
  onClick,
}: {
  label: string;
  description?: string;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <Button
      variant={selected ? 'default' : 'outline'}
      size="sm"
      className="text-xs h-7"
      disabled={disabled}
      onClick={onClick}
      title={description}
    >
      {label}
    </Button>
  );
}

/* ─── Ask User Block (interactive tool UI) ─── */
export function AskUserBlock({
  request,
  answered,
  onResolve,
}: {
  request: import('@/lib/tools/ask-user').AskUserRequest;
  answered?: boolean;
  onResolve?: (response: import('@/lib/tools/ask-user').AskUserResponse) => void;
}) {
  // Normalize: the raw tool arguments may be in legacy format ({ question, options })
  // rather than the new internal format ({ questions: [...] }).
  const normalized = normalizeRequest(request as Record<string, unknown>);
  const fields = normalized.questions;

  // Mode A: compact single-question mode (no title, single field)
  if (fields.length === 1 && !request.title && !request.description) {
    return (
      <AskUserCompactBlock
        field={fields[0]}
        answered={answered}
        onResolve={onResolve}
      />
    );
  }

  // Mode B: multi-field form
  return (
    <FormBlock
      request={normalized}
      answered={!!answered}
      onResolve={onResolve}
    />
  );
}

/* ─── Ask User Compact Block (mode A: single question) ─── */

function AskUserCompactBlock({
  field,
  answered,
  onResolve,
}: {
  field: import('@/lib/tools/ask-user').AskUserQuestion;
  answered?: boolean;
  onResolve?: (response: import('@/lib/tools/ask-user').AskUserResponse) => void;
}) {
  const [freeText, setFreeText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const question = field.question;
  const options = field.options;
  const allowFreeText = field.allow_free_text ?? (options == null || options.length === 0);
  const type = field.type ?? (options && options.length > 0 ? 'single_select' : 'text');

  const handleFreeTextSubmit = () => {
    if (!freeText.trim()) return;
    onResolve?.({ answers: { [field.id]: { value: freeText.trim() } } });
    setFreeText('');
  };

  const handleOptionSelect = (opt: { label: string; value: string }) => {
    onResolve?.({ answers: { [field.id]: { value: opt.value } } });
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleFreeTextSubmit();
    }
  };

  return (
    <div className={`relative mt-3 p-3.5 border border-primary/20 bg-primary/5 rounded-lg ${answered ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-2 text-primary font-medium text-[0.85rem] mb-1.5">
        <CircleHelp className="size-4.5 shrink-0 mt-0.5" />
        <span className="whitespace-pre-wrap">{question}</span>
      </div>

      {/* Option buttons */}
      {(() => {
        const safeOptions = Array.isArray(options)
          ? options.filter((o): o is NonNullable<typeof options>[number] =>
              !!o && typeof o === 'object' && typeof o.label === 'string'
            )
          : [];
        if (safeOptions.length === 0) return null;
        return (
          <div className="flex flex-wrap gap-2 mt-2.5">
            {safeOptions.map((opt, i) => (
              <PromptOptionButton
                key={`${i}-${opt.value ?? opt.label}`}
                label={opt.label}
                description={opt.description}
                disabled={!onResolve}
                onClick={onResolve ? () => handleOptionSelect(opt) : undefined}
              />
            ))}
          </div>
        );
      })()}

      {/* Free text input */}
      {allowFreeText && onResolve && (
        <div className="flex items-end gap-1.5 mt-2.5">
          <textarea
            ref={textareaRef}
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={field.placeholder || t('chat.askUser.placeholder')}
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

/* ─── Permission Request Block (tool pre-execution authorization) ─── */
// 渲染一条 permissionRequest 自定义消息。三种态：
// - answerable（pending 且 isLive）：三按钮可点，卡片正常。
// - decided（once/always/denied/dismissed）：卡片置灰；被选中的按钮高亮，
//   dismissed（发消息隐式未授权）无任何按钮高亮。
// - expired（pending 但 !isLive，例如 SW 重启后无活 agent 在等）：卡片置灰，
//   按钮禁用，额外显示「已失效」。
export function PermissionRequestBlock({
  title,
  permissions,
  decision,
  isLive,
  onResolve,
}: {
  title: string;
  permissions: string[];
  decision: 'pending' | 'once' | 'always' | 'denied' | 'dismissed';
  isLive: boolean;
  onResolve?: (decision: 'once' | 'always' | 'denied') => void;
}) {
  const pending = decision === 'pending';
  const answerable = pending && isLive && !!onResolve;
  const expired = pending && !isLive;

  return (
    <div className={`relative mt-3 p-3.5 border border-primary/20 bg-primary/5 rounded-lg ${answerable ? '' : 'opacity-60'}`}>
      <div className="flex items-start gap-2 text-primary font-medium text-[0.85rem] mb-1.5">
        <ShieldAlert className="size-4.5 shrink-0 mt-0.5" />
        <span className="whitespace-pre-wrap">{title}</span>
      </div>

      {/* Requested permissions — omitted entirely when none declared */}
      {permissions.length > 0 && (
        <div className="text-[0.8rem] text-muted-foreground">
          {t('chat.permission.requests')}
          <ul className="mt-1 space-y-1">
            {permissions.map((perm, i) => (
              <li key={`${i}-${perm}`} className="flex items-start gap-1.5">
                <span className="text-primary/60 mt-0.5 shrink-0">•</span>
                <span>{describePermission(perm)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Expired notice — only when a persisted pending card has no live agent */}
      {expired && (
        <div className="text-xs text-muted-foreground/80 italic mt-2">
          {t('chat.permission.expired')}
        </div>
      )}

      {/* Decision buttons */}
      <div className="flex flex-wrap gap-2 mt-2.5">
        <PromptOptionButton
          label={t('chat.permission.deny')}
          selected={decision === 'denied'}
          disabled={!answerable}
          onClick={answerable ? () => onResolve!('denied') : undefined}
        />
        <PromptOptionButton
          label={t('chat.permission.allowOnce')}
          selected={decision === 'once'}
          disabled={!answerable}
          onClick={answerable ? () => onResolve!('once') : undefined}
        />
        <PromptOptionButton
          label={t('chat.permission.allowAlways')}
          selected={decision === 'always'}
          disabled={!answerable}
          onClick={answerable ? () => onResolve!('always') : undefined}
        />
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

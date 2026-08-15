import type {
  Message,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  ImageContent,
} from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { unescapeXml } from '@/lib/utils';

// ─── Parsed attachment metadata for UI display ───

export interface ParsedUserAttachments {
  images: { data: string; mimeType: string }[];
  elements: { selector: string }[];
  files: { name: string; type: string }[];
  recordings: { name: string; eventCount: number; durationMs: number; truncated: boolean; json: string }[];
}

/** Extract plain text from an AssistantMessage's content blocks */
export function getAssistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Extract thinking blocks from an AssistantMessage (skips empty summaries) */
export function getThinkingBlocks(msg: AssistantMessage): ThinkingContent[] {
  return msg.content.filter(
    (b): b is ThinkingContent => b.type === 'thinking' && !!b.thinking?.trim(),
  );
}

/** Extract tool calls from an AssistantMessage */
export function getToolCalls(msg: AssistantMessage): ToolCall[] {
  return msg.content.filter((b): b is ToolCall => b.type === 'toolCall');
}

/** Find the ToolResultMessage for a given tool call id */
export function findToolResult(
  messages: AgentMessage[],
  toolCallId: string,
): ToolResultMessage | undefined {
  return messages.find(
    (m): m is ToolResultMessage =>
      m.role === 'toolResult' && m.toolCallId === toolCallId,
  );
}

const USER_REQUEST_RE = /<user-request>\s*([\s\S]*?)\s*<\/user-request>/;

/** Extract the raw text string from a user message (handles string and block-array formats). */
function getRawUserText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b): b is { type: 'text'; text: string } => 'type' in b && b.type === 'text')
      .map(b => b.text)
      .join('');
  }
  return '';
}

/** Extract the user's actual input text from a structured user message.
 *  Reads the content of the <user-request> block. */
export function extractUserText(msg: Message): string {
  if (msg.role !== 'user') return '';
  const raw = getRawUserText(msg);
  const match = raw.match(USER_REQUEST_RE);
  return match ? match[1].trim() : raw.trim();
}

const ELEMENT_RE = /<selected-element\s+selector="([^"]*)"[^>]*>/g;
const FILE_RE = /<attached-file\s+name="([^"]*)"\s+type="([^"]*)">/g;
// Body is XML-escaped JSON. Recorded `<`/`>`/`&` chars are encoded as
// entities so they can't fake a `</recording>` or `</attachments>` close
// tag, keeping the non-greedy boundary unambiguous.
const RECORDING_RE = /<recording\s+name="([^"]*)"\s+mime="[^"]*"\s+event-count="(\d+)"\s+duration-ms="(\d+)"(\s+truncated="true")?>\n([\s\S]*?)\n<\/recording>/g;
const ATTACHMENTS_BLOCK_RE = /<attachments>([\s\S]*?)<\/attachments>/;

/** Extract attachment metadata from a user message for display in the chat bubble. */
export function extractUserAttachments(msg: Message): ParsedUserAttachments {
  const result: ParsedUserAttachments = { images: [], elements: [], files: [], recordings: [] };
  if (msg.role !== 'user') return result;

  // Extract images from content blocks
  if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if ('type' in block && block.type === 'image') {
        const img = block as ImageContent;
        result.images.push({ data: img.data, mimeType: img.mimeType });
      }
    }
  }

  // Extract element/file metadata from the <attachments> block
  const raw = getRawUserText(msg);
  const attachBlock = raw.match(ATTACHMENTS_BLOCK_RE)?.[1] ?? '';

  for (const m of attachBlock.matchAll(ELEMENT_RE)) {
    result.elements.push({ selector: unescapeXml(m[1]) });
  }
  for (const m of attachBlock.matchAll(FILE_RE)) {
    result.files.push({
      name: unescapeXml(m[1]),
      type: unescapeXml(m[2]),
    });
  }
  for (const m of attachBlock.matchAll(RECORDING_RE)) {
    result.recordings.push({
      name: unescapeXml(m[1]),
      eventCount: Number(m[2]),
      durationMs: Number(m[3]),
      truncated: !!m[4],
      json: unescapeXml(m[5]),
    });
  }

  return result;
}

/**
 * Compute the transcript slice that "retry" should restart from: everything
 * up to and including the most recent user message. Drops the failed/unwanted
 * assistant turn plus any orphan toolUse / toolResult blocks that came after it.
 *
 * Returns `null` when no user message exists — callers should treat this as
 * "nothing to retry" (the UI normally prevents this, but defensive).
 *
 * Shared by the background `retry()` and the sidepanel's optimistic UI update
 * so both sides truncate identically — multi-window reconciliation never flickers.
 */
export function truncateForRetry<M extends { role: string }>(messages: M[]): M[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return messages.slice(0, i + 1);
    }
  }
  return null;
}

/**
 * 把 user 消息的正文替换为新文本（消息编辑，issue #44），保留附件结构：
 * - 有 `<user-request>` 包裹（composeUserMessage 的产物）时只替换其内文，
 *   `<attachments>` 等兄弟块原样保留；
 * - 无包裹（划词固化等裸文本）时替换整段文本；
 * - content 为块数组时替换第一个含 `<user-request>` 的 text 块（无则第一个
 *   text 块；一个 text 块都没有则追加一个），image 等其它块不动。
 *
 * 与后台 editMessage / 前端乐观更新共用，保证多窗口收敛时两侧算出同一形状。
 * 纯函数、不改入参。
 */
export function replaceUserText<M extends Message>(msg: M, newText: string): M {
  // replacement 用函数形式，避免 newText 里的 `$&` / `$1` 被 String.replace 当特殊模式展开
  const replaceInRaw = (raw: string): string =>
    USER_REQUEST_RE.test(raw)
      ? raw.replace(USER_REQUEST_RE, () => `<user-request>\n${newText}\n</user-request>`)
      : newText;

  if (typeof msg.content === 'string') {
    return { ...msg, content: replaceInRaw(msg.content) };
  }
  if (Array.isArray(msg.content)) {
    const blocks = msg.content as { type?: string; text?: string }[];
    let target = blocks.findIndex(
      (b) => b.type === 'text' && typeof b.text === 'string' && USER_REQUEST_RE.test(b.text),
    );
    if (target < 0) target = blocks.findIndex((b) => b.type === 'text');
    if (target < 0) {
      return { ...msg, content: [...blocks, { type: 'text', text: newText }] } as M;
    }
    const content = blocks.map((b, i) =>
      i === target ? { ...b, text: replaceInRaw(b.text ?? '') } : b,
    );
    return { ...msg, content } as M;
  }
  return msg;
}

// ─── 消息形态规整（类型契约兜底）───

/** 把单个内容块里为 null / undefined 的字符串字段兜成空串；块无需矫正时原样返回同一引用 */
function sanitizeBlock(block: unknown): unknown {
  if (!block || typeof block !== 'object') return block;
  const b = block as Record<string, unknown>;
  // text / thinking / name 在 pi 类型里都是 string；个别 provider 返回或旧数据可能落成
  // null，`== null` 同时覆盖 null 与 undefined
  if (b.type === 'text' && b.text == null) return { ...b, text: '' };
  if (b.type === 'thinking' && b.thinking == null) return { ...b, thinking: '' };
  if (b.type === 'toolCall' && b.name == null) return { ...b, name: '' };
  return block;
}

/** 矫正一个内容块数组；无改动时原样返回同一引用，只复制受影响的块 */
function sanitizeBlocks(blocks: unknown[]): unknown[] {
  let out: unknown[] | null = null;
  for (let i = 0; i < blocks.length; i++) {
    const original = blocks[i];
    const fixed = sanitizeBlock(original);
    if (fixed !== original && out === null) out = blocks.slice(0, i);
    if (out !== null) out.push(fixed);
  }
  return out ?? blocks;
}

/** 矫正一条消息；无改动时原样返回同一引用 */
function sanitizeMessage(msg: AgentMessage): AgentMessage {
  // 仅标准 Message 角色带 content；compactionSummary 等自定义消息无 content 字段，跳过，
  // 避免给它们凭空塞一个 content
  if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'toolResult') {
    return msg;
  }
  const content: unknown = (msg as Message).content;
  // 顶层 content 缺失 → 空数组（对齐 pi transformMessages 的规整）
  if (content == null) {
    return { ...msg, content: [] } as AgentMessage;
  }
  // 字符串 content（常见于 user 消息）无嵌套块，原样返回
  if (!Array.isArray(content)) {
    return msg;
  }
  const fixed = sanitizeBlocks(content);
  return fixed === content ? msg : ({ ...msg, content: fixed } as AgentMessage);
}

/**
 * 把消息整形回 pi 的类型契约后再送入 pi。个别 provider 返回 / 旧会话数据可能让
 * assistant 内容块的 `text` / `thinking` / `name` 落成 `null`，而 pi 的 token 估算器
 * （`clampMaxTokensToContext` → `estimateMessageTokens`）对这些字段无保护地取 `.length`，
 * 一旦命中就整轮抛「Cannot read properties of null (reading 'length')」，把对话卡死
 * （issue #43）。上游把这类归为「调用方违反类型契约」不予修复（earendil-works/pi
 * #6568 等），故在此把 null / undefined 兜成空串，顶层缺失的 content 兜成空数组。
 *
 * copy-on-write：整条数组 / 消息 / 块在无需矫正时一律返回同一引用，仅在实际需要矫正时
 * 才复制受影响的那一层，因此热路径（每轮 convertToLlm）在常态下零分配、只做一次扫描。
 * 纯函数、不改动入参
 */
export function sanitizeAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  let out: AgentMessage[] | null = null;
  for (let i = 0; i < messages.length; i++) {
    const original = messages[i];
    const fixed = sanitizeMessage(original);
    if (fixed !== original && out === null) out = messages.slice(0, i);
    if (out !== null) out.push(fixed);
  }
  return out ?? messages;
}

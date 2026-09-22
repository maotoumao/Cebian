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
import { SLASH_PROMPT_ONLY_REQUEST } from '@/lib/ai-config/slash-prompt';
import { USER_REQUEST_CLOSE, USER_REQUEST_OPEN, wrapUserRequest } from '@/lib/agent/prompt-envelope';

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

/** 信封末尾那个 `<user-request>` 块：`{ start, end, text }`，没有则 null。 */
interface UserRequestBlock {
  /** `<user-request>` 开标签在原串里的下标。 */
  start: number;
  /** 闭标签之后的下标（切片用的右开区间）。 */
  end: number;
  text: string;
}

/**
 * 定位信封的**末块** `<user-request>`。
 *
 * 判据是位置而非正则匹配：`composeUserMessage` 恒把请求块放在最后，所以合法的信封必然
 * 以 `</user-request>` 收尾；而开标签取**最靠前**的那个。
 *
 * 「取最前」成立的前提是：请求块前面的各块都由本扩展生成，其中页面可控的部分已被转义
 * （模板变量，见 lib/ai-config/template.ts）或剥离（页面上下文）。所以字面量
 * `<user-request>` 基本只会出自用户敲进请求块**内部**的文本，外层开标签必然在它之前。
 * 取最后一个反而会选中用户打出来的那个内层标签，提取出半截文本、编辑时留下一个悬空的
 * 外层开标签。
 */
function matchUserRequest(raw: string): UserRequestBlock | null {
  const trimmed = raw.trimEnd();
  if (!trimmed.endsWith(USER_REQUEST_CLOSE)) return null;
  const start = trimmed.indexOf(USER_REQUEST_OPEN);
  if (start < 0) return null;
  const bodyStart = start + USER_REQUEST_OPEN.length;
  const bodyEnd = trimmed.length - USER_REQUEST_CLOSE.length;
  if (bodyEnd < bodyStart) return null;
  return { start, end: trimmed.length, text: trimmed.slice(bodyStart, bodyEnd).trim() };
}

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

const SLASH_PROMPT_RE = /<slash-prompt name="([^"]*)">\n?([\s\S]*?)\n?<\/slash-prompt>/;

/** Extract the user's actual input text from a structured user message.
 *  Reads the content of the <user-request> block.
 *
 *  只挂了斜杠提示词、一个字没打的那一轮，请求块里放的是指向提示词块的占位句
 *  （`SLASH_PROMPT_ONLY_REQUEST`，见 lib/ai-config/slash-prompt.ts）。那句话是写给
 *  模型看的，不是用户的输入——这里当作空文本，免得它出现在用户气泡和 ↑ 历史里。 */
export function extractUserText(msg: Message): string {
  if (msg.role !== 'user') return '';
  const raw = getRawUserText(msg);
  // 没有信封包裹的裸文本只剩一种来源：划词动作「在侧边栏继续」固化下来的页面文本
  //（UI 的乐观消息现在也带完整信封，见 dispatchPrompt）。那种情况整段就是用户的话。
  const match = matchUserRequest(raw);
  const text = match ? match.text : raw.trim();
  // 占位句是精确匹配。用户恰好手打出这句一模一样的英文时会被当成空文本（气泡与 ↑
  // 历史里都看不到它）——概率可以忽略，且代价只是少显示一行，不值得为它把「没打字」
  // 这个信号改成一个用户敲不出来的结构标记。
  if (text === SLASH_PROMPT_ONLY_REQUEST && SLASH_PROMPT_RE.test(raw)) return '';
  return text;
}

/** 取出这一轮携带的斜杠提示词（名字 + 正文），没有则返回 null。
 *  与 `buildSlashPromptBlock` 反向对应；`name` 建块时按属性转义过，这里还原回去。 */
export function extractSlashPrompt(msg: Message): { name: string; body: string } | null {
  if (msg.role !== 'user') return null;
  const match = getRawUserText(msg).match(SLASH_PROMPT_RE);
  if (!match) return null;
  return { name: unescapeXml(match[1]), body: match[2] };
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
 * 轮内压缩会把摘要追加在最后一条 user **之后**，这里照样把它切掉——**不要**特判保留。
 * 两个理由：一是返回值必须是原数组的**连续前缀**，调用方拿 `truncated.length` 当作树上
 * 保留的前缀长度去回卷 lane、裁 `entryIds`、压水位线，塞一条位置对不上的摘要进来会让
 * 内存转录与树彻底错位（摘要被误附上别人的 entryId、且永远不会落树）；二是语义上本来
 * 就该切掉——retry 丢弃的是整轮，而那条摘要摘的正是这一轮里的内容，它的 `retainedTail`
 * 指向的也是同一批被丢弃的消息，留下来只会让模型从被撤销的工具结果接着往下写。切掉后
 * 上下文比压缩前更小，不存在「retry 把超长上下文重新发出去」的问题。
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
 * - content 为块数组时替换**最后**一个含末尾请求块的 text 块（无则第一个 text 块；
 *   一个 text 块都没有则追加一个），image 等其它块不动。
 *
 * 与后台 editMessage / 前端乐观更新共用，保证多窗口收敛时两侧算出同一形状。
 * 纯函数、不改入参。
 */
export function replaceUserText<M extends Message>(msg: M, newText: string): M {
  // 只替换**末尾**那个 `<user-request>`（理由见 matchUserRequest）。按下标切片而非
  // String.replace，顺带也避开了 newText 里的 `$&` / `$1` 被当特殊模式展开。
  const replaceInRaw = (raw: string): string => {
    const match = matchUserRequest(raw);
    if (!match) return newText;
    return (
      raw.slice(0, match.start) +
      wrapUserRequest(newText) +
      raw.slice(match.end)
    );
  };

  if (typeof msg.content === 'string') {
    return { ...msg, content: replaceInRaw(msg.content) };
  }
  if (Array.isArray(msg.content)) {
    const blocks = msg.content as { type?: string; text?: string }[];
    // 从后往前找：请求块恒在信封末尾，因此带着它的必然是**最后**一个符合条件的 text
    // 块。从前往后找会被前面块里的字面量骗走，改错地方而不报错。
    let target = -1;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.type === 'text' && typeof b.text === 'string' && matchUserRequest(b.text) !== null) {
        target = i;
        break;
      }
    }
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

/** pi 可能显式写入值为 undefined 的可选字段，而 durable payload 契约要求这类字段必须省略 */
function omitUndefinedFields<T extends object>(value: T): T {
  const record = value as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const key of Object.keys(record)) {
    if (record[key] !== undefined) continue;
    out ??= { ...record };
    delete out[key];
  }
  return (out ?? value) as T;
}

/** 矫正一条消息；无改动时原样返回同一引用 */
function sanitizeMessage(msg: AgentMessage): AgentMessage {
  // 仅标准 Message 角色带 content；compactionSummary 等自定义消息无 content 字段，跳过，
  // 避免给它们凭空塞一个 content
  if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'toolResult') {
    return msg;
  }
  const clean = omitUndefinedFields(msg);
  const content: unknown = (clean as Message).content;
  // 顶层 content 缺失 → 空数组（对齐 pi transformMessages 的规整）
  if (content == null) {
    return { ...clean, content: [] } as AgentMessage;
  }
  // 字符串 content（常见于 user 消息）无嵌套块，原样返回
  if (!Array.isArray(content)) {
    return clean;
  }
  const fixed = sanitizeBlocks(content);
  return fixed === content ? clean : ({ ...clean, content: fixed } as AgentMessage);
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

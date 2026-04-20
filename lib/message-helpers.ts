import type {
  Message,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  ImageContent,
} from '@mariozechner/pi-ai';

// ─── Parsed attachment metadata for UI display ───

export interface ParsedUserAttachments {
  images: { data: string; mimeType: string }[];
  elements: { selector: string }[];
  files: { name: string; type: string }[];
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
  messages: Message[],
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
const ATTACHMENTS_BLOCK_RE = /<attachments>([\s\S]*?)<\/attachments>/;

/** Extract attachment metadata from a user message for display in the chat bubble. */
export function extractUserAttachments(msg: Message): ParsedUserAttachments {
  const result: ParsedUserAttachments = { images: [], elements: [], files: [] };
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
    result.elements.push({ selector: m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') });
  }
  for (const m of attachBlock.matchAll(FILE_RE)) {
    result.files.push({
      name: m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
      type: m[2].replace(/&amp;/g, '&'),
    });
  }

  return result;
}

import type {
  Message,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
} from '@mariozechner/pi-ai';
import { CONTEXT_STRIP_RE } from './page-context';
import { ATTACHMENT_STRIP_RE } from './attachments';

/** Extract plain text from an AssistantMessage's content blocks */
export function getAssistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Extract thinking blocks from an AssistantMessage */
export function getThinkingBlocks(msg: AssistantMessage): ThinkingContent[] {
  return msg.content.filter((b): b is ThinkingContent => b.type === 'thinking');
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

/** Extract plain text from a user message (handles string and block-array formats).
 *  Strips <cebian-context> blocks so the UI only shows the user's actual input. */
export function extractUserText(msg: Message): string {
  if (msg.role !== 'user') return '';
  let raw = '';
  if (typeof msg.content === 'string') {
    raw = msg.content;
  } else if (Array.isArray(msg.content)) {
    raw = msg.content
      .filter((b): b is { type: 'text'; text: string } => 'type' in b && b.type === 'text')
      .map(b => b.text)
      .join('');
  }
  return raw.replace(CONTEXT_STRIP_RE, '').replace(ATTACHMENT_STRIP_RE, '').trim();
}

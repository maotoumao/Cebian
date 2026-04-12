import type {
  Message,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
} from '@mariozechner/pi-ai';

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

/** Extract plain text from a user message (handles string and block-array formats) */
export function extractUserText(msg: Message): string {
  if (msg.role !== 'user') return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b): b is { type: 'text'; text: string } => 'type' in b && b.type === 'text')
      .map(b => b.text)
      .join('');
  }
  return '';
}

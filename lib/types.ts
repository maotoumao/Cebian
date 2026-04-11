import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  ImageContent,
} from '@mariozechner/pi-ai';

// Re-export pi-ai types for convenience
export type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  ImageContent,
};

// ─── Tool name constants ───

/** Tool that pauses the agent loop to ask the user a question */
export const TOOL_ASK_USER = 'ask_user' as const;
/** Tool that executes JS in the active tab */
export const TOOL_EXECUTE_SCRIPT = 'executeScript' as const;

// ─── Helpers ───

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

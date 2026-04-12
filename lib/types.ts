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
/** Tool that executes arbitrary JS in the active tab */
export const TOOL_EXECUTE_JS = 'execute_js' as const;

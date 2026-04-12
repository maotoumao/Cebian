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
/** Tool that extracts page content in various formats */
export const TOOL_READ_PAGE = 'read_page' as const;
/** Tool that simulates user interactions on the page */
export const TOOL_INTERACT = 'interact' as const;
/** Tool that manages browser tabs */
export const TOOL_TAB = 'tab' as const;

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
/** Tool that returns a structured DOM snapshot for selector discovery */
export const TOOL_INSPECT = 'inspect' as const;
/** Tool that manages browser tabs */
export const TOOL_TAB = 'tab' as const;
/** Tool that captures a screenshot of the active tab */
export const TOOL_SCREENSHOT = 'screenshot' as const;

// ─── Filesystem tool name constants ───

/** Tool that creates a new file in the virtual filesystem */
export const TOOL_FS_CREATE_FILE = 'fs_create_file' as const;
/** Tool that edits a file via precise string replacement */
export const TOOL_FS_EDIT_FILE = 'fs_edit_file' as const;
/** Tool that creates a directory in the virtual filesystem */
export const TOOL_FS_MKDIR = 'fs_mkdir' as const;
/** Tool that renames or moves a file/directory */
export const TOOL_FS_RENAME = 'fs_rename' as const;
/** Tool that deletes a file or directory */
export const TOOL_FS_DELETE = 'fs_delete' as const;
/** Tool that reads file content from the virtual filesystem */
export const TOOL_FS_READ_FILE = 'fs_read_file' as const;
/** Tool that lists directory contents */
export const TOOL_FS_LIST = 'fs_list' as const;
/** Tool that searches for files by name or content */
export const TOOL_FS_SEARCH = 'fs_search' as const;
/** Tool that executes skill scripts with declared chrome.* permissions */
export const TOOL_RUN_SKILL = 'run_skill' as const;
/** Tool that calls Chrome browser APIs directly via structured parameters */
export const TOOL_CHROME_API = 'chrome_api' as const;

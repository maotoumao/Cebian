import type { AgentTool } from '@mariozechner/pi-agent-core';
import { createSessionAskUserTool } from './ask-user';
import { executeJsTool } from './execute-js';
import { readPageTool } from './read-page';
import { interactTool } from './interact';
import { tabTool } from './tab';
import { screenshotTool } from './screenshot';
import { fsCreateFileTool } from './fs-create-file';
import { fsEditFileTool } from './fs-edit-file';
import { fsMkdirTool } from './fs-mkdir';
import { fsRenameTool } from './fs-rename';
import { fsDeleteTool } from './fs-delete';
import { fsReadFileTool } from './fs-read-file';
import { fsListTool } from './fs-list';
import { fsSearchTool } from './fs-search';
import { executeSkillCodeTool } from './execute-skill-code';
import { chromeApiTool } from './chrome-api-tool';
import { SessionToolContext } from './session-context';
import { TOOL_ASK_USER } from '@/lib/types';

/** Non-interactive tools shared by all sessions. */
const sharedTools: AgentTool<any>[] = [
  executeJsTool, readPageTool, interactTool, tabTool, screenshotTool,
  fsCreateFileTool, fsEditFileTool, fsMkdirTool, fsRenameTool, fsDeleteTool,
  fsReadFileTool, fsListTool, fsSearchTool,
  executeSkillCodeTool,
  chromeApiTool,
];

/**
 * Create a session-specific tools array with its own SessionToolContext.
 * Each session gets independent bridges so concurrent sessions don't conflict.
 * To add a new interactive tool, register it here — agent-manager needs no changes.
 */
export function createSessionTools(): {
  tools: AgentTool<any>[];
  ctx: SessionToolContext;
} {
  const ctx = new SessionToolContext();

  // Register interactive tools (each gets its own bridge)
  const { tool: askUserTool, bridge: askUserBridge } = createSessionAskUserTool();
  ctx.register(TOOL_ASK_USER, askUserBridge);

  return {
    tools: [askUserTool, ...sharedTools],
    ctx,
  };
}

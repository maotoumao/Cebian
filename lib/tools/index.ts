import type { AgentTool } from '@mariozechner/pi-agent-core';
import { createSessionAskUserTool, type AskUserRequest } from './ask-user';
import { executeJsTool } from './execute-js';
import { readPageTool } from './read-page';
import { interactTool } from './interact';
import { tabTool } from './tab';
import { screenshotTool } from './screenshot';
import type { InteractiveBridge } from './interactive-bridge';

/** Non-interactive tools shared by all sessions. */
const sharedTools: AgentTool<any>[] = [
  executeJsTool, readPageTool, interactTool, tabTool, screenshotTool,
];

/**
 * Create a session-specific tools array with its own ask_user bridge.
 * Each session gets an independent bridge so concurrent sessions don't conflict.
 */
export function createSessionTools(): {
  tools: AgentTool<any>[];
  askUserBridge: InteractiveBridge<AskUserRequest, string>;
} {
  const { tool, bridge } = createSessionAskUserTool();
  return {
    tools: [tool, ...sharedTools],
    askUserBridge: bridge,
  };
}

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { createSessionAskUserTool } from './ask-user';
import { executeJsTool } from './execute-js';
import { readPageTool } from './read-page';
import { interactTool } from './interact';
import { inspectTool } from './inspect';
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
import { runSkillTool } from './run-skill';
import { chromeApiTool } from './chrome-api-tool';
import { SessionToolContext } from './session-context';
import { TOOL_ASK_USER } from '@/lib/types';
import { getMCPManager } from '@/lib/mcp/manager';
import { createMCPAgentTool } from './mcp-tool';

/** Non-interactive tools shared by all sessions. */
const sharedTools: AgentTool<any>[] = [
  executeJsTool, readPageTool, interactTool, inspectTool, tabTool, screenshotTool,
  fsCreateFileTool, fsEditFileTool, fsMkdirTool, fsRenameTool, fsDeleteTool,
  fsReadFileTool, fsListTool, fsSearchTool,
  runSkillTool,
  chromeApiTool,
];

/**
 * Discover MCP tools across all enabled servers, isolating per-server failures.
 * Returns AgentTool instances ready to merge into a session's tool array.
 *
 * Safe to call repeatedly — manager caches results with a long TTL and dedups
 * concurrent refreshes.
 */
export async function discoverMCPTools(): Promise<AgentTool<any>[]> {
  const mcpResults = await getMCPManager().getAllTools();
  const out: AgentTool<any>[] = [];
  for (const result of mcpResults) {
    if (result.error) {
      console.warn(`[mcp] failed to load tools from "${result.server.name}":`, result.error);
      continue;
    }
    for (const t of result.tools) {
      out.push(createMCPAgentTool(result.server, t));
    }
  }
  return out;
}

/**
 * Build the full tool array for a session = interactive tools + shared + MCP.
 * Used both at session creation and when MCP config changes mid-session.
 *
 * Interactive tools come from the session's own `SessionToolContext`, so
 * agent-manager doesn't need to know which interactive tools exist.
 */
export async function buildSessionToolArray(
  ctx: SessionToolContext,
): Promise<AgentTool<any>[]> {
  const mcpTools = await discoverMCPTools();
  return [...ctx.getInteractiveTools(), ...sharedTools, ...mcpTools];
}

/**
 * Create a session-specific tools array with its own SessionToolContext.
 * Each session gets independent bridges so concurrent sessions don't conflict.
 *
 * Async because MCP tool discovery may need to fetch from remote servers
 * (cached by the manager so subsequent sessions are fast).
 */
export async function createSessionTools(): Promise<{
  tools: AgentTool<any>[];
  ctx: SessionToolContext;
}> {
  const ctx = new SessionToolContext();

  // Register interactive tools (each gets its own bridge)
  const { tool: askUserTool, bridge: askUserBridge } = createSessionAskUserTool();
  ctx.register(TOOL_ASK_USER, askUserBridge, askUserTool);

  const tools = await buildSessionToolArray(ctx);

  return { tools, ctx };
}

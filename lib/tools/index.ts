import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createSessionAskUserTool } from './ask-user';
import { executeJsTool } from './execute-js';
import { readPageTool } from './read-page';
import { interactTool } from './interact';
import { inspectTool } from './inspect';
import { tabTool } from './tab';
import { screenshotTool } from './screenshot';
import { pdfTool } from './pdf';
import { fsCreateFileTool } from './fs-create-file';
import { fsEditFileTool } from './fs-edit-file';
import { fsMkdirTool } from './fs-mkdir';
import { fsRenameTool } from './fs-rename';
import { fsDeleteTool } from './fs-delete';
import { fsReadFileTool } from './fs-read-file';
import { fsListTool } from './fs-list';
import { fsSearchTool } from './fs-search';
import { fsSaveUrlTool } from './fs-save-url';
import { createSessionRunSkillTool } from './run-skill';
import { chromeApiTool } from './chrome-api-tool';
import { SessionToolContext } from './session-context';
import { TOOL_ASK_USER } from '@/lib/tools/names';
import { getMCPManager } from '@/lib/mcp/manager';
import { createMCPAgentTool } from './mcp-tool';

/** Non-interactive tools shared by all sessions. `runSkillTool` is intentionally
 *  NOT here —— 每个 session 用 `createSessionRunSkillTool(sessionId)` 拿到
 *  绑定到该 session workspace 的实例，避免 vfs 写入丢失会话上下文。 */
const sharedTools: AgentTool<any>[] = [
  executeJsTool, readPageTool, interactTool, inspectTool, tabTool, screenshotTool, pdfTool,
  fsCreateFileTool, fsEditFileTool, fsMkdirTool, fsRenameTool, fsDeleteTool,
  fsReadFileTool, fsListTool, fsSearchTool, fsSaveUrlTool,
  chromeApiTool,
];

/**
 * Discover MCP tools across all enabled servers, isolating per-server failures.
 * Returns AgentTool instances ready to merge into a session's tool array.
 *
 * Safe to call repeatedly — manager caches results with a long TTL and dedups
 * concurrent refreshes.
 *
 * Filters out tools whose `_meta.ui.visibility` excludes `"model"` per MCP
 * Apps SEP-1865 — those are app-only tools (callable by the iframe via
 * `tools/call` but invisible to the LLM). v1 doesn't proxy app-initiated
 * tool calls, so app-only tools are effectively dormant; we still exclude
 * them from the agent's list to honour the spec and avoid polluting the
 * LLM with unreachable options.
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
      const visibility = t._meta?.ui?.visibility;
      if (Array.isArray(visibility) && !visibility.includes('model')) {
        // Spec MUST: do not expose app-only tools to the agent. Warn once
        // per discovery so a user wondering where their tool went finds
        // an answer in the BG console rather than digging through specs.
        console.warn(`[mcp] hidden from agent: "${t.name}" on "${result.server.name}" — _meta.ui.visibility=${JSON.stringify(visibility)}`);
        continue;
      }
      out.push(createMCPAgentTool(result.server, t));
    }
  }
  return out;
}

/**
 * Build the full tool array for a session = interactive tools + shared + MCP +
 * the per-session `run_skill` instance (sessionId-bound so its vfs writes land
 * in the session's workspace).
 *
 * Used both at session creation and when MCP config changes mid-session.
 */
export async function buildSessionToolArray(
  ctx: SessionToolContext,
): Promise<AgentTool<any>[]> {
  const mcpTools = await discoverMCPTools();
  const runSkill = createSessionRunSkillTool(ctx.sessionId);
  return [...ctx.getInteractiveTools(), ...sharedTools, runSkill, ...mcpTools];
}

/**
 * Create a session-specific tools array with its own SessionToolContext.
 * Each session gets independent bridges so concurrent sessions don't conflict.
 *
 * Async because MCP tool discovery may need to fetch from remote servers
 * (cached by the manager so subsequent sessions are fast).
 */
export async function createSessionTools(sessionId: string): Promise<{
  tools: AgentTool<any>[];
  ctx: SessionToolContext;
}> {
  const ctx = new SessionToolContext(sessionId);

  // Register interactive tools (each gets its own bridge)
  const { tool: askUserTool, bridge: askUserBridge } = createSessionAskUserTool();
  ctx.register(TOOL_ASK_USER, askUserBridge, askUserTool);

  const tools = await buildSessionToolArray(ctx);

  return { tools, ctx };
}

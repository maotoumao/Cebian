// Background Agent Manager — singleton that manages Agent instances.
// Each session gets its own Agent + SessionToolContext (per-session isolation).

import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import { getModels, type KnownProvider } from '@mariozechner/pi-ai';
import { createCebianAgent } from '@/lib/agent';
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/constants';
import { scanSkillIndex, buildSkillsBlock } from '@/lib/ai-config/scanner';
import { sessionStore } from './session-store';
import { gatherPageContext } from '@/lib/page-context';
import { buildTextPrefix, extractImages, type Attachment } from '@/lib/attachments';
import { createSessionTools } from '@/lib/tools';
import type { SessionToolContext } from '@/lib/tools/session-context';
import type { ServerMessage } from '@/lib/protocol';
import type { SessionRecord } from '@/lib/db';
import {
  providerCredentials,
  customProviders as customProvidersStorage,
  activeModel as activeModelStorage,
  thinkingLevel as thinkingLevelStorage,
  systemPrompt as systemPromptStorage,
  maxRounds as maxRoundsStorage,
} from '@/lib/storage';
import { getCopilotBaseUrl } from '@/lib/oauth';
import { mergeCustomProviders, isCustomProvider, findCustomModel } from '@/lib/custom-models';
import { PRESET_PROVIDERS } from '@/lib/constants';

// ─── Structured user message builder ───

async function buildStructuredMessage(text: string, attachments: Attachment[]): Promise<string> {
  const parts: string[] = [];

  // ① Session-dynamic config: inject skill index
  const skillMetas = await scanSkillIndex();
  const skillsBlock = buildSkillsBlock(skillMetas);
  parts.push(`<agent-config>\n${skillsBlock}\n</agent-config>`);

  // ② Tool/behavior reminders (placeholder)
  parts.push('<reminder-instructions>\n</reminder-instructions>');

  // ③ Attachments (elements + files; images go via multimodal content blocks)
  const attachmentBlock = buildTextPrefix(attachments);
  if (attachmentBlock) parts.push(attachmentBlock);

  // ④ Context: date + page state
  const ctxLines: string[] = [];
  ctxLines.push(`The current date is ${new Date().toLocaleDateString('en-CA')}.`);
  const pageCtx = await gatherPageContext();
  if (pageCtx) {
    ctxLines.push('');
    ctxLines.push(pageCtx);
  }
  parts.push(`<context>\n${ctxLines.join('\n')}\n</context>`);

  // ⑤ User request (always last)
  // TODO: user text is NOT sanitized — users are trusted; stripping structural tags would alter their intent.
  parts.push(`<user-request>\n${text.trim()}\n</user-request>`);

  return parts.join('\n\n');
}

// ─── Types ───

interface ManagedSession {
  agent: Agent;
  sessionId: string;
  sessionCreated: boolean;
  isRunning: boolean;
  modelKey: string;
  /** Unified interactive tool bridge manager for this session. */
  toolCtx: SessionToolContext;
  unsubscribeAgent: () => void;
  unsubscribeToolCtx: () => void;
}

type BroadcastFn = (sessionId: string, msg: ServerMessage) => void;

// ─── Agent Manager ───

// Service Worker keepalive interval (25 s) — resets Chrome's 30 s idle timer.
// Reference: https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers#keep-sw-alive
// Since Chrome 110, any extension API call resets the idle timer.
const SW_KEEPALIVE_INTERVAL_MS = 25_000;

class AgentManager {
  private sessions = new Map<string, ManagedSession>();
  /** Guards against concurrent getOrCreateAgent calls for the same session. */
  private creating = new Map<string, Promise<ManagedSession>>();
  private broadcast: BroadcastFn = () => {};
  /** Periodic timer that calls a trivial Chrome API to prevent SW termination while agents run. */
  private keepAliveTimer: number | null = null;

  setBroadcast(fn: BroadcastFn): void {
    this.broadcast = fn;
  }

  /**
   * Start or stop the SW keepalive timer based on whether any session is running.
   * Uses chrome.runtime.getPlatformInfo — a no-op read-only API — to reset
   * Chrome's 30 s idle shutdown timer every 25 s.
   * Ref: https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers#keep-sw-alive
   */
  private updateKeepAlive(): void {
    const hasRunning = [...this.sessions.values()].some(s => s.isRunning);
    if (hasRunning && !this.keepAliveTimer) {
      this.keepAliveTimer = setInterval(chrome.runtime.getPlatformInfo, SW_KEEPALIVE_INTERVAL_MS) as unknown as number;
    } else if (!hasRunning && this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private async resolveModelObj(): Promise<{ model: Model<Api>; provider: string; modelId: string } | null> {
    const [modelCfg, creds, customProvs] = await Promise.all([
      activeModelStorage.getValue(),
      providerCredentials.getValue(),
      customProvidersStorage.getValue(),
    ]);
    if (!modelCfg) return null;

    const allCustom = mergeCustomProviders(PRESET_PROVIDERS, customProvs ?? []);
    let model: Model<Api> | undefined;

    if (isCustomProvider(modelCfg.provider)) {
      model = findCustomModel(allCustom, modelCfg.provider, modelCfg.modelId) ?? undefined;
    } else {
      try {
        const models = getModels(modelCfg.provider as KnownProvider) as Model<Api>[];
        model = models.find(m => m.id === modelCfg.modelId);
      } catch {
        return null;
      }
    }
    if (!model) return null;

    if (modelCfg.provider === 'github-copilot') {
      const cred = creds[modelCfg.provider];
      if (cred?.authType === 'oauth') {
        model = { ...model, baseUrl: getCopilotBaseUrl(cred) };
      }
    }

    return { model, provider: modelCfg.provider, modelId: modelCfg.modelId };
  }

  /** Get or create a managed agent for a session */
  private async getOrCreateAgent(sessionId: string, existingMessages?: AgentMessage[]): Promise<ManagedSession> {
    const existing = this.sessions.get(sessionId);
    if (existing && !existingMessages) return existing;

    // Guard against concurrent creation
    const pending = this.creating.get(sessionId);
    if (pending && !existingMessages) return pending;

    const promise = this.createAgent(sessionId, existingMessages);
    this.creating.set(sessionId, promise);
    try {
      const managed = await promise;
      return managed;
    } finally {
      this.creating.delete(sessionId);
    }
  }

  /** Internal: actually create the agent (called only once per session). */
  private async createAgent(sessionId: string, existingMessages?: AgentMessage[]): Promise<ManagedSession> {

    const resolved = await this.resolveModelObj();
    if (!resolved) throw new Error('No model selected or model not found');

    const [thinkingLvl, sysPrompt, rounds] = await Promise.all([
      thinkingLevelStorage.getValue(),
      systemPromptStorage.getValue(),
      maxRoundsStorage.getValue(),
    ]);

    // Use provided messages, or load from DB, or start empty
    let messages: AgentMessage[] = existingMessages ?? [];
    let sessionCreated = false;
    if (!existingMessages) {
      const existingSession = await sessionStore.load(sessionId);
      messages = existingSession?.messages ?? [];
      sessionCreated = !!existingSession;
    }

    // Create per-session tools with isolated bridges
    const { tools: sessionTools, ctx: toolCtx } = createSessionTools();

    const agent = createCebianAgent({
      model: resolved.model,
      systemPrompt: sysPrompt || DEFAULT_SYSTEM_PROMPT,
      thinkingLevel: (thinkingLvl || 'medium') as any,
      maxRounds: rounds || 200,
      messages,
      tools: sessionTools,
    });

    const managed: ManagedSession = {
      agent,
      sessionId,
      sessionCreated,
      isRunning: false,
      modelKey: `${resolved.provider}/${resolved.modelId}`,
      toolCtx,
      unsubscribeAgent: () => {},
      unsubscribeToolCtx: () => {},
    };

    // Subscribe to agent events
    managed.unsubscribeAgent = agent.subscribe(async (event: AgentEvent) => {
      await this.handleAgentEvent(managed, event);
    });

    // Subscribe to all interactive tool state changes for this session
    managed.unsubscribeToolCtx = toolCtx.subscribe((toolName, pending) => {
      if (pending) {
        this.broadcast(sessionId, {
          type: 'tool_pending',
          sessionId,
          toolName,
          toolCallId: pending.toolCallId,
          args: pending.request,
        });
      } else {
        this.broadcast(sessionId, {
          type: 'tool_resolved',
          sessionId,
          toolName,
        });
      }
    });

    this.sessions.set(sessionId, managed);
    return managed;
  }

  private async handleAgentEvent(managed: ManagedSession, event: AgentEvent): Promise<void> {
    const { sessionId, agent } = managed;

    switch (event.type) {
      case 'agent_start':
        managed.isRunning = true;
        this.broadcast(sessionId, { type: 'agent_start', sessionId });
        this.updateKeepAlive();
        break;

      case 'message_update':
        if ('role' in event.message && event.message.role === 'assistant') {
          this.broadcast(sessionId, {
            type: 'message_update',
            sessionId,
            message: event.message,
          });
        }
        break;

      case 'message_end': {
        const messages = [...agent.state.messages];
        this.broadcast(sessionId, { type: 'message_end', sessionId, messages });
        if (managed.sessionCreated) {
          sessionStore.scheduleWrite(sessionId, messages);
        }
        break;
      }

      case 'agent_end': {
        managed.isRunning = false;
        this.updateKeepAlive();
        // Cancel any pending interactive tools on this session
        managed.toolCtx.cancelAll();
        const messages = [...agent.state.messages];
        this.broadcast(sessionId, { type: 'agent_end', sessionId, messages });
        await sessionStore.flush(sessionId);
        break;
      }
    }
  }

  /** Send a prompt to the agent for a session */
  async prompt(sessionId: string, text: string, attachments: Attachment[] = []): Promise<void> {
    let managed = await this.getOrCreateAgent(sessionId);

    // Check if the model has changed since the agent was created
    const currentModel = await activeModelStorage.getValue();
    if (currentModel) {
      const currentKey = `${currentModel.provider}/${currentModel.modelId}`;
      if (currentKey !== managed.modelKey) {
        // Model changed — recreate with new model, preserving in-memory messages
        const currentMessages = [...managed.agent.state.messages];
        const wasCreated = managed.sessionCreated;
        managed.unsubscribeAgent();
        managed.unsubscribeToolCtx();
        managed.toolCtx.dispose();
        this.sessions.delete(sessionId);
        this.updateKeepAlive();
        managed = await this.getOrCreateAgent(sessionId, currentMessages);
        managed.sessionCreated = wasCreated;
      }
    }

    // Persist the session on first prompt so the UI can navigate to /chat/<id>
    // immediately (unlocking "new chat" and history visibility) instead of
    // waiting for agent_end. Messages are filled in by the throttled writer
    // on subsequent message_end events.
    if (!managed.sessionCreated) {
      const [modelCfg, sysPrompt, thinkingLvl] = await Promise.all([
        activeModelStorage.getValue(),
        systemPromptStorage.getValue(),
        thinkingLevelStorage.getValue(),
      ]);
      const title = text.trim().slice(0, 50) + (text.trim().length > 50 ? '...' : '');
      const session: SessionRecord = {
        id: sessionId,
        title: title || '新对话',
        model: modelCfg?.modelId ?? '',
        provider: modelCfg?.provider ?? '',
        systemPrompt: sysPrompt || '',
        thinkingLevel: thinkingLvl || 'medium',
        messageCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };
      await sessionStore.create(session);
      managed.sessionCreated = true;
      this.broadcast(sessionId, {
        type: 'session_created',
        sessionId,
        title: session.title,
      });
    }

    const enriched = await buildStructuredMessage(text, attachments);

    const images = extractImages(attachments);

    // If any interactive tool is pending, steer the agent instead of prompting
    if (managed.toolCtx.hasPending()) {
      const content: any[] = [{ type: 'text', text: enriched }];
      if (images.length > 0) content.push(...images);
      const userMessage: AgentMessage = {
        role: 'user',
        content,
        timestamp: Date.now(),
      } as AgentMessage;
      // Enqueue BEFORE cancelling so getSteeringMessages() sees it when the loop drains.
      managed.agent.steer(userMessage);
      managed.toolCtx.cancelAll();
    } else {
      await managed.agent.prompt(enriched, images.length > 0 ? images : undefined);
    }
  }

  /** Cancel the active agent for a session */
  cancel(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      managed.agent.abort();
      managed.unsubscribeAgent();
      managed.toolCtx.dispose();
      this.sessions.delete(sessionId);
      this.updateKeepAlive();
      // Ensure client knows the agent stopped (abort may not fire agent_end)
      this.broadcast(sessionId, {
        type: 'agent_end',
        sessionId,
        messages: [...managed.agent.state.messages],
      });
    }
  }

  /** Resolve an interactive tool's pending request */
  resolveTool(sessionId: string, toolName: string, response: any): void {
    const managed = this.sessions.get(sessionId);
    // ctx subscription handles broadcasting tool_resolved
    managed?.toolCtx.resolve(toolName, response);
  }

  /** Cancel a specific interactive tool */
  cancelTool(sessionId: string, toolName: string): void {
    const managed = this.sessions.get(sessionId);
    // ctx subscription handles broadcasting tool_resolved
    managed?.toolCtx.cancel(toolName);
  }

  /** Get current state for a session (for reconnecting clients) */
  getSessionState(sessionId: string): { messages: AgentMessage[]; isRunning: boolean } | null {
    const managed = this.sessions.get(sessionId);
    if (!managed) return null;
    return {
      messages: [...managed.agent.state.messages],
      isRunning: managed.isRunning,
    };
  }

  /** Destroy a managed session entirely */
  destroySession(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      managed.unsubscribeAgent();
      managed.toolCtx.dispose();
      managed.agent.abort();
      this.sessions.delete(sessionId);
      this.updateKeepAlive();
    }
  }
}

export const agentManager = new AgentManager();

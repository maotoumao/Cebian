// Background Agent Manager — singleton that manages Agent instances.
// Each session gets its own Agent + ask_user bridge (per-session isolation).

import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import { getModels, type KnownProvider } from '@mariozechner/pi-ai';
import { createCebianAgent } from '@/lib/agent';
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/constants';
import { sessionStore } from './session-store';
import { gatherPageContext } from '@/lib/page-context';
import { buildTextPrefix, extractImages, type Attachment } from '@/lib/attachments';
import { extractUserText } from '@/lib/message-helpers';
import { createSessionTools } from '@/lib/tools';
import { TOOL_ASK_USER } from '@/lib/types';
import type { InteractiveBridge } from '@/lib/tools/interactive-bridge';
import type { AskUserRequest } from '@/lib/tools/ask-user';
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

// ─── Types ───

interface ManagedSession {
  agent: Agent;
  sessionId: string;
  sessionCreated: boolean;
  isRunning: boolean;
  /** provider/modelId used to create this agent, for detecting model changes. */
  modelKey: string;
  /** Per-session ask_user bridge. */
  askUserBridge: InteractiveBridge<AskUserRequest, string>;
  /** Whether the ask_user bridge currently has a pending request. */
  toolPending: boolean;
  /** Cleanup: unsubscribe from agent events. */
  unsubscribeAgent: () => void;
  /** Cleanup: unsubscribe from bridge state changes. */
  unsubscribeBridge: () => void;
}

type BroadcastFn = (sessionId: string, msg: ServerMessage) => void;

// ─── Agent Manager ───

class AgentManager {
  private sessions = new Map<string, ManagedSession>();
  /** Guards against concurrent getOrCreateAgent calls for the same session. */
  private creating = new Map<string, Promise<ManagedSession>>();
  private broadcast: BroadcastFn = () => {};

  setBroadcast(fn: BroadcastFn): void {
    this.broadcast = fn;
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

    // Create per-session tools with isolated ask_user bridge
    const { tools: sessionTools, askUserBridge } = createSessionTools();

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
      askUserBridge,
      toolPending: false,
      unsubscribeAgent: () => {},
      unsubscribeBridge: () => {},
    };

    // Subscribe to agent events
    managed.unsubscribeAgent = agent.subscribe(async (event: AgentEvent) => {
      await this.handleAgentEvent(managed, event);
    });

    // Subscribe to this session's bridge state changes for tool_pending/tool_resolved
    managed.unsubscribeBridge = askUserBridge.subscribe((pending) => {
      if (pending && !managed.toolPending) {
        // null → pending
        managed.toolPending = true;
        this.broadcast(sessionId, {
          type: 'tool_pending',
          sessionId,
          toolName: TOOL_ASK_USER,
          toolCallId: pending.toolCallId,
          args: pending.request,
        });
      } else if (!pending && managed.toolPending) {
        // pending → null
        managed.toolPending = false;
        this.broadcast(sessionId, {
          type: 'tool_resolved',
          sessionId,
          toolName: TOOL_ASK_USER,
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
        // Cancel any pending ask_user on this session's bridge
        managed.askUserBridge.cancel();
        const messages = [...agent.state.messages];
        this.broadcast(sessionId, { type: 'agent_end', sessionId, messages });

        if (!managed.sessionCreated && messages.length > 0) {
          const modelCfg = await activeModelStorage.getValue();
          const sysPrompt = await systemPromptStorage.getValue();
          const thinkingLvl = await thinkingLevelStorage.getValue();

          const firstUserText = extractUserText(messages[0]);
          const title = firstUserText.slice(0, 50) + (firstUserText.length > 50 ? '...' : '');
          const session: SessionRecord = {
            id: sessionId,
            title: title || '新对话',
            model: modelCfg?.modelId ?? '',
            provider: modelCfg?.provider ?? '',
            systemPrompt: sysPrompt || '',
            thinkingLevel: thinkingLvl || 'medium',
            messageCount: messages.length,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCost: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages,
          };
          await sessionStore.create(session);
          managed.sessionCreated = true;
          this.broadcast(sessionId, {
            type: 'session_created',
            sessionId,
            title: session.title,
          });
        } else if (managed.sessionCreated) {
          await sessionStore.flush(sessionId);
        }
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
        managed.unsubscribeBridge();
        this.sessions.delete(sessionId);
        managed = await this.getOrCreateAgent(sessionId, currentMessages);
        managed.sessionCreated = wasCreated;
      }
    }

    const ctx = await gatherPageContext();

    const parts: string[] = [];
    if (ctx) parts.push(ctx);
    const prefix = buildTextPrefix(attachments);
    if (prefix) parts.push(prefix);
    parts.push(text.trim());
    const enriched = parts.join('\n\n');

    const images = extractImages(attachments);

    // If this session's ask_user is pending, steer the agent instead of prompting
    if (managed.askUserBridge.getPending()) {
      const content: any[] = [{ type: 'text', text: enriched }];
      if (images.length > 0) content.push(...images);
      const userMessage: AgentMessage = {
        role: 'user',
        content,
        timestamp: Date.now(),
      } as AgentMessage;
      // Enqueue BEFORE cancelling so getSteeringMessages() sees it when the loop drains.
      managed.agent.steer(userMessage);
      managed.askUserBridge.cancel();
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
      managed.unsubscribeBridge();
      this.sessions.delete(sessionId);
      // Ensure client knows the agent stopped (abort may not fire agent_end)
      this.broadcast(sessionId, {
        type: 'agent_end',
        sessionId,
        messages: [...managed.agent.state.messages],
      });
    }
  }

  /** Resolve an interactive tool's pending request */
  resolveTool(sessionId: string, _toolName: string, response: any): void {
    const managed = this.sessions.get(sessionId);
    // Bridge subscription handles broadcasting tool_resolved
    managed?.askUserBridge.resolve(response);
  }

  /** Cancel a specific interactive tool */
  cancelTool(sessionId: string, _toolName: string): void {
    const managed = this.sessions.get(sessionId);
    // Bridge subscription handles broadcasting tool_resolved
    managed?.askUserBridge.cancel();
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
      managed.unsubscribeBridge();
      managed.agent.abort();
      this.sessions.delete(sessionId);
    }
  }
}

export const agentManager = new AgentManager();

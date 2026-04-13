// Background Agent Manager — singleton that manages Agent instances.
// Replaces useAgentLifecycle: all agent execution happens here.

import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import { getModels, type KnownProvider } from '@mariozechner/pi-ai';
import { createCebianAgent } from '@/lib/agent';
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/constants';
import { sessionStore } from './session-store';
import { gatherPageContext } from '@/lib/page-context';
import { buildTextPrefix, extractImages, type Attachment } from '@/lib/attachments';
import { extractUserText } from '@/lib/message-helpers';
import { interactiveToolRegistry } from '@/lib/tools/registry';
import { askUserBridge } from '@/lib/tools/ask-user';
import { TOOL_ASK_USER } from '@/lib/types';
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

// ─── Register interactive tool bridges (BG side) ───

interactiveToolRegistry.register<any, string>({
  name: TOOL_ASK_USER,
  bridge: askUserBridge,
});

// ─── Types ───

interface ManagedSession {
  agent: Agent;
  sessionId: string;
  sessionCreated: boolean;
  isRunning: boolean;
  unsubscribe: () => void;
}

type BroadcastFn = (sessionId: string, msg: ServerMessage) => void;

// ─── Agent Manager ───

class AgentManager {
  private sessions = new Map<string, ManagedSession>();
  /** Guards against concurrent getOrCreateAgent calls for the same session. */
  private creating = new Map<string, Promise<ManagedSession>>();
  private broadcast: BroadcastFn = () => {};
  /** Tracks which tools are currently pending, to detect state transitions. */
  private pendingToolNames = new Set<string>();

  constructor() {
    // Subscribe to interactive tool bridge state changes.
    // Only broadcast on actual state transitions: null→pending or pending→null.
    interactiveToolRegistry.subscribe(() => {
      for (const info of interactiveToolRegistry.getAll()) {
        const pending = interactiveToolRegistry.getPendingFor(info.name);
        const wasPending = this.pendingToolNames.has(info.name);

        if (pending && !wasPending) {
          // null → pending: tool just became pending
          this.pendingToolNames.add(info.name);
          for (const managed of this.sessions.values()) {
            if (!managed.isRunning) continue;
            this.broadcast(managed.sessionId, {
              type: 'tool_pending',
              sessionId: managed.sessionId,
              toolName: info.name,
              toolCallId: pending.toolCallId,
              args: pending.request,
            });
          }
        } else if (!pending && wasPending) {
          // pending → null: tool was resolved or cancelled
          this.pendingToolNames.delete(info.name);
          for (const managed of this.sessions.values()) {
            if (!managed.isRunning) continue;
            this.broadcast(managed.sessionId, {
              type: 'tool_resolved',
              sessionId: managed.sessionId,
              toolName: info.name,
            });
          }
        }
        // If state didn't change (pending→pending or null→null), do nothing
      }
    });
  }

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
  private async getOrCreateAgent(sessionId: string): Promise<ManagedSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    // Guard against concurrent creation
    const pending = this.creating.get(sessionId);
    if (pending) return pending;

    const promise = this.createAgent(sessionId);
    this.creating.set(sessionId, promise);
    try {
      const managed = await promise;
      return managed;
    } finally {
      this.creating.delete(sessionId);
    }
  }

  /** Internal: actually create the agent (called only once per session). */
  private async createAgent(sessionId: string): Promise<ManagedSession> {

    const resolved = await this.resolveModelObj();
    if (!resolved) throw new Error('No model selected or model not found');

    const [thinkingLvl, sysPrompt, rounds] = await Promise.all([
      thinkingLevelStorage.getValue(),
      systemPromptStorage.getValue(),
      maxRoundsStorage.getValue(),
    ]);

    // Load existing messages if session exists in DB
    const existingSession = await sessionStore.load(sessionId);
    const messages = existingSession?.messages ?? [];

    const agent = createCebianAgent({
      model: resolved.model,
      systemPrompt: sysPrompt || DEFAULT_SYSTEM_PROMPT,
      thinkingLevel: (thinkingLvl || 'medium') as any,
      maxRounds: rounds || 200,
      messages,
    });

    const managed: ManagedSession = {
      agent,
      sessionId,
      sessionCreated: !!existingSession,
      isRunning: false,
      unsubscribe: () => {},
    };

    // Subscribe to agent events
    managed.unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      await this.handleAgentEvent(managed, event);
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
        // Cancel any pending interactive tools so their bridges are cleaned up
        interactiveToolRegistry.cancelAll();
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
    const managed = await this.getOrCreateAgent(sessionId);
    const ctx = await gatherPageContext();

    const parts: string[] = [];
    if (ctx) parts.push(ctx);
    const prefix = buildTextPrefix(attachments);
    if (prefix) parts.push(prefix);
    parts.push(text.trim());
    const enriched = parts.join('\n\n');

    const images = extractImages(attachments);

    // If any interactive tool is pending, steer the agent instead of prompting
    if (interactiveToolRegistry.hasPending()) {
      const content: any[] = [{ type: 'text', text: enriched }];
      if (images.length > 0) content.push(...images);
      const userMessage: AgentMessage = {
        role: 'user',
        content,
        timestamp: Date.now(),
      } as AgentMessage;
      // Enqueue BEFORE cancelling so getSteeringMessages() sees it when the loop drains.
      managed.agent.steer(userMessage);
      interactiveToolRegistry.cancelAll();
    } else {
      await managed.agent.prompt(enriched, images.length > 0 ? images : undefined);
    }
  }

  /** Cancel the active agent for a session */
  cancel(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      managed.agent.abort();
      // Recreate agent on next prompt (abort invalidates the agent)
      managed.unsubscribe();
      this.sessions.delete(sessionId);
    }
  }

  /** Resolve an interactive tool's pending request */
  resolveTool(sessionId: string, toolName: string, response: any): void {
    interactiveToolRegistry.resolve(toolName, response);
    this.broadcast(sessionId, { type: 'tool_resolved', sessionId, toolName });
  }

  /** Cancel a specific interactive tool */
  cancelTool(sessionId: string, toolName: string): void {
    interactiveToolRegistry.cancelOne(toolName);
    this.broadcast(sessionId, { type: 'tool_resolved', sessionId, toolName });
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
      managed.unsubscribe();
      managed.agent.abort();
      this.sessions.delete(sessionId);
    }
  }
}

export const agentManager = new AgentManager();

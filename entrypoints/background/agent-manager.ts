// Background Agent Manager — singleton that manages Agent instances.
// Each session gets its own Agent + SessionToolContext (per-session isolation).

import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, AssistantMessage, Model } from '@mariozechner/pi-ai';
import { getModels, type KnownProvider } from '@mariozechner/pi-ai';
import { createCebianAgent } from '@/lib/agent';
import { scanSkillIndex, buildSkillsBlock } from '@/lib/ai-config/scanner';
import { sessionStore } from './session-store';
import { gatherPageContext } from '@/lib/page-context';
import { buildTextPrefix, extractImages, type Attachment } from '@/lib/attachments';
import { createSessionTools, buildSessionToolArray } from '@/lib/tools';
import type { SessionToolContext } from '@/lib/tools/session-context';
import type { ServerMessage } from '@/lib/protocol';
import type { SessionRecord } from '@/lib/db';
import { truncateForRetry } from '@/lib/message-helpers';
import {
  providerCredentials,
  customProviders as customProvidersStorage,
  activeModel as activeModelStorage,
  thinkingLevel as thinkingLevelStorage,
  userInstructions as userInstructionsStorage,
  maxRounds as maxRoundsStorage,
} from '@/lib/storage';
import { getMCPManager } from '@/lib/mcp/manager';
import { getCopilotBaseUrl } from '@/lib/oauth';
import { mergeCustomProviders, isCustomProvider, findCustomModel } from '@/lib/custom-models';
import { PRESET_PROVIDERS } from '@/lib/constants';
import { t } from '@/lib/i18n';
import { acquireKeepAlive, releaseKeepAlive } from './sw-keepalive';

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

/**
 * Lifecycle phase of a managed session.
 *
 * - `idle`: agent exists but is not running — waiting for next prompt/retry.
 *   This is the initial state and the resting state after `agent_end`.
 * - `rebuilding`: retry (or another rebuild path) is tearing down the old
 *   agent and constructing a new one. The `ManagedSession` entry stays in
 *   `sessions` throughout this phase so external operations (notably `cancel`)
 *   can still reach it; the `agent` / `toolCtx` fields may be transiently
 *   stale and must not be touched until phase flips back to `idle` or
 *   forward to `running`.
 * - `running`: the agent is actively streaming a turn. Set by the
 *   `agent_start` event, cleared by `agent_end`.
 *
 * Invariant: a session entry is in `sessions` iff its lifetime hasn't ended.
 * The previous design temporarily evicted entries during rebuild, which
 *  made `cancel()` silently no-op when it raced the rebuild window — that
 * is exactly the bug this phase machine fixes.
 */
type ManagedPhase = 'idle' | 'rebuilding' | 'running';

interface ManagedSession {
  agent: Agent;
  sessionId: string;
  sessionCreated: boolean;
  phase: ManagedPhase;
  /**
   * Set while `phase === 'rebuilding'`. `cancel()` aborts this signal to
   * interrupt a retry's async rebuild; the rebuild path checks `signal.aborted`
   * at each await boundary and bails cleanly without calling `agent.continue()`.
   * Cleared back to `undefined` when rebuilding ends (either success or abort).
   */
  rebuildController?: AbortController;
  modelKey: string;
  /** Unified interactive tool bridge manager for this session. */
  toolCtx: SessionToolContext;
  unsubscribeAgent: () => void;
  unsubscribeToolCtx: () => void;
}

type BroadcastFn = (sessionId: string, msg: ServerMessage) => void;

// ─── Agent Manager ───

class AgentManager {
  private sessions = new Map<string, ManagedSession>();
  /** Guards against concurrent getOrCreateAgent calls for the same session. */
  private creating = new Map<string, Promise<ManagedSession>>();
  private broadcast: BroadcastFn = () => {};
  /** True iff we're currently holding a SW keep-alive token. Tracked so
   *  acquire/release stay balanced even across error paths. */
  private keepAliveHeld = false;
  /** Subscription to MCPManager change notifications; pushes refreshed tools into every live session. */
  private mcpUnsubscribe?: () => void;

  setBroadcast(fn: BroadcastFn): void {
    this.broadcast = fn;
    // Subscribe to MCPManager so we react AFTER its internal entries map is
    // reconciled — avoids racing two independent storage watchers.
    if (!this.mcpUnsubscribe) {
      this.mcpUnsubscribe = getMCPManager().subscribe(() => {
        void this.refreshAllSessionTools();
      });
    }
  }

  /**
   * Rebuild every live session's tool array from current MCP config.
   * Called when the user adds, removes, enables, disables, or edits an MCP
   * server. The agent's `state.tools` setter accepts a fresh array, so a
   * mid-run update is safe — the next assistant turn picks up the new tools.
   *
   * Sessions refresh in parallel; manager-level dedup prevents fan-out reconnects.
   */
  private async refreshAllSessionTools(): Promise<void> {
    if (this.sessions.size === 0) return;
    await Promise.allSettled(
      Array.from(this.sessions.values()).map(async (managed) => {
        try {
          const tools = await buildSessionToolArray(managed.toolCtx);
          managed.agent.state.tools = tools;
        } catch (err) {
          console.warn(`[mcp] failed to refresh tools for session ${managed.sessionId}:`, err);
        }
      }),
    );
  }

  /**
   * Acquire / release a SW keep-alive token based on whether any session
   * has active work in flight. Counts both `running` (agent streaming) and
   * `rebuilding` (retry's async setup) so the SW doesn't suspend mid-rebuild
   * — a suspension there would leave the session with phase='rebuilding'
   * but no actual rebuild in flight, since phase is in-memory state.
   *
   * Uses the shared ref-counted helper in `sw-keepalive.ts` so multiple
   * subsystems (agent runs, active recordings, ...) coexist without
   * stomping each other.
   */
  private updateKeepAlive(): void {
    const hasActive = [...this.sessions.values()].some(s => s.phase !== 'idle');
    if (hasActive && !this.keepAliveHeld) {
      this.keepAliveHeld = true;
      acquireKeepAlive();
    } else if (!hasActive && this.keepAliveHeld) {
      this.keepAliveHeld = false;
      releaseKeepAlive();
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
    const built = await this.buildAgentArtifacts(sessionId, existingMessages);
    const managed: ManagedSession = {
      agent: built.agent,
      sessionId,
      sessionCreated: built.sessionCreated,
      phase: 'idle',
      modelKey: built.modelKey,
      toolCtx: built.toolCtx,
      unsubscribeAgent: () => {},
      unsubscribeToolCtx: () => {},
    };
    this.wireSubscriptions(managed);
    this.sessions.set(sessionId, managed);
    return managed;
  }

  /**
   * Build a fresh Agent + tool context for a session without installing it
   * into the managed map or wiring subscriptions. Returns raw artifacts so
   * the caller decides how to attach them to a `ManagedSession`:
   *
   * - `createAgent` constructs a brand-new managed entry and writes it to
   *   the map.
   * - `retry()` swaps the artifacts onto an existing managed entry that
   *   remains in the map throughout — preserving the "cancel can always
   *   find the entry" invariant.
   *
   * When `existingMessages` is provided, the returned `sessionCreated` is
   * always `false` because we don't consult DB — callers using this path
   * (retry) preserve the existing entry's `sessionCreated` themselves.
   */
  private async buildAgentArtifacts(
    sessionId: string,
    existingMessages?: AgentMessage[],
  ): Promise<{
    agent: Agent;
    toolCtx: SessionToolContext;
    modelKey: string;
    sessionCreated: boolean;
  }> {
    const resolved = await this.resolveModelObj();
    if (!resolved) throw new Error('No model selected or model not found');

    const [thinkingLvl, instructions, rounds] = await Promise.all([
      thinkingLevelStorage.getValue(),
      userInstructionsStorage.getValue(),
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
    const { tools: sessionTools, ctx: toolCtx } = await createSessionTools(sessionId);

    const agent = createCebianAgent({
      model: resolved.model,
      sessionId,
      userInstructions: instructions || '',
      thinkingLevel: (thinkingLvl || 'medium') as any,
      maxRounds: rounds || 200,
      messages,
      tools: sessionTools,
    });

    return {
      agent,
      toolCtx,
      modelKey: `${resolved.provider}/${resolved.modelId}`,
      sessionCreated,
    };
  }

  /**
   * Wire agent + toolCtx event subscriptions into a managed session.
   * Replaces any previously-installed subscriptions — caller must ensure
   * prior `unsubscribeAgent` / `unsubscribeToolCtx` were invoked first,
   * otherwise the old listeners leak and double-fire events.
   *
   * The subscription callbacks close over `managed`, so swapping the
   * `agent` / `toolCtx` fields on an existing managed entry and re-wiring
   * keeps `handleAgentEvent` pointing at the right object — there is no
   * stale closure problem.
   */
  private wireSubscriptions(managed: ManagedSession): void {
    managed.unsubscribeAgent = managed.agent.subscribe(async (event: AgentEvent) => {
      await this.handleAgentEvent(managed, event);
    });
    managed.unsubscribeToolCtx = managed.toolCtx.subscribe((toolName, pending) => {
      if (pending) {
        this.broadcast(managed.sessionId, {
          type: 'tool_pending',
          sessionId: managed.sessionId,
          toolName,
          toolCallId: pending.toolCallId,
          args: pending.request,
        });
      } else {
        this.broadcast(managed.sessionId, {
          type: 'tool_resolved',
          sessionId: managed.sessionId,
          toolName,
        });
      }
    });
  }

  private async handleAgentEvent(managed: ManagedSession, event: AgentEvent): Promise<void> {
    const { sessionId, agent } = managed;

    switch (event.type) {
      case 'agent_start':
        // Any path that calls `agent.continue()` / `agent.prompt()` ends up
        // here — including retry, which leaves phase='rebuilding' until this
        // event flips it forward to 'running'. Direct prompt() entries go
        // 'idle' → 'running'; both transitions are valid and collapse to a
        // single line.
        managed.phase = 'running';
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
        managed.phase = 'idle';
        this.updateKeepAlive();
        // Cancel any pending interactive tools on this session
        managed.toolCtx.cancelAll();
        const messages = [...agent.state.messages];
        this.broadcast(sessionId, { type: 'agent_end', sessionId, messages });
        // Persist final state before flushing. Normally the trailing
        // `message_end` already scheduled a write with the same content,
        // but pi-agent-core's `handleRunFailure` (abort/error path) appends
        // a synthetic assistant marker straight to `state.messages` and
        // fires `agent_end` without a preceding `message_end` — so without
        // this schedule the marker reaches subscribed clients via the
        // broadcast above but never lands in DB, and disappears on the
        // next cold-load. The scheduler is idempotent for unchanged
        // content so this is safe to call unconditionally on every
        // agent_end.
        if (managed.sessionCreated) {
          sessionStore.scheduleWrite(sessionId, messages);
        }
        await sessionStore.flush(sessionId);
        break;
      }
    }
  }

  /** Send a prompt to the agent for a session */
  async prompt(sessionId: string, text: string, attachments: Attachment[] = []): Promise<void> {
    // Persist + broadcast 'session_created' for brand-new sessions BEFORE any
    // agent setup work (model resolve, tool factory, MCP, createAgent — easily
    // several hundred ms). Without this the UI stays on /chat/new with an empty
    // title and a no-op "new chat" button until the first agent_start arrives.
    //
    // Detection: not in the live sessions map AND no DB record. The DB record
    // we write here is what getOrCreateAgent's sessionStore.load() will find,
    // so `managed.sessionCreated` is set to true by createAgent() naturally,
    // and we don't need a second persist-and-broadcast inside this method.
    if (!this.sessions.has(sessionId)) {
      const existing = await sessionStore.load(sessionId);
      if (!existing) {
        const [modelCfg, instructions, thinkingLvl] = await Promise.all([
          activeModelStorage.getValue(),
          userInstructionsStorage.getValue(),
          thinkingLevelStorage.getValue(),
        ]);
        // Mirror the old behavior: refuse to create a session row when no
        // model is selected. Otherwise the subsequent getOrCreateAgent() throws
        // and we'd leave an orphan empty-model row in Dexie + history.
        if (!modelCfg) {
          throw new Error('No model selected or model not found');
        }
        const trimmed = text.trim();
        const title = trimmed.slice(0, 50) + (trimmed.length > 50 ? '...' : '');
        const session: SessionRecord = {
          id: sessionId,
          title: title || t('common.newChat'),
          model: modelCfg.modelId,
          provider: modelCfg.provider,
          userInstructions: instructions || '',
          thinkingLevel: thinkingLvl || 'medium',
          messageCount: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [],
        };
        try {
          await sessionStore.create(session);
          this.broadcast(sessionId, {
            type: 'session_created',
            sessionId,
            title: session.title,
          });
        } catch (err: any) {
          // Race: another concurrent prompt() for the same brand-new id won
          // the create. Re-throw anything that isn't a duplicate-key violation;
          // the winning call has already broadcast 'session_created'.
          if (err?.name !== 'ConstraintError') throw err;
        }
      }
    }

    const managed = await this.getOrCreateAgent(sessionId);

    if (managed.phase === 'rebuilding') {
      // Another rebuild is already in flight (a retry, or another prompt
      // that hit the model-switch branch). The UI gates the composer to
      // prevent concurrent prompts, but a stale or out-of-order IPC could
      // still arrive — without this guard, our model-switch branch below
      // would overwrite `managed.rebuildController` and orphan the
      // in-flight one. Silently dropping matches `retry()`'s phase-guard
      // pattern; the in-flight rebuild's broadcasts reconcile every
      // subscribed window to the correct state.
      console.debug('[agent-manager] prompt: phase rebuilding, ignored', sessionId);
      return;
    }

    // Check if the model has changed since the agent was created
    const currentModel = await activeModelStorage.getValue();
    if (currentModel) {
      const currentKey = `${currentModel.provider}/${currentModel.modelId}`;
      if (currentKey !== managed.modelKey) {
        // Model changed — recreate with new model, preserving in-memory
        // messages. Same lifecycle invariant as retry's rebuild: the
        // managed entry stays in `sessions` throughout the async work
        // so a `cancel` racing the build can find it via the phase
        // machinery instead of silently no-op'ing on a missing entry.
        const currentMessages = [...managed.agent.state.messages];
        managed.phase = 'rebuilding';
        managed.rebuildController = new AbortController();
        const signal = managed.rebuildController.signal;
        this.updateKeepAlive();

        try {
          // Tear down old in place. `sessionCreated` is preserved by
          // leaving the field untouched. `cancelAll` on the toolCtx
          // matches retry's teardown — any pending interactive tools
          // get a `tool_resolved` broadcast so subscribed sidepanels
          // learn they were cancelled.
          managed.toolCtx.cancelAll();
          managed.unsubscribeAgent();
          managed.unsubscribeToolCtx();
          managed.toolCtx.dispose();

          const built = await this.buildAgentArtifacts(sessionId, currentMessages);

          if (signal.aborted) {
            // Cancel landed during the build. Bail without ever calling
            // `agent.prompt()` — the user clicked stop fast enough that
            // their message wasn't actually committed (no agent_start,
            // no DB write of the new turn). The optimistic user message
            // in subscribed sidepanels gets cleared by the broadcast
            // below; that's the intended undo semantic for pre-commit
            // cancels, distinct from retry-cancel which preserves the
            // already-committed prior turn behind an aborted marker.
            built.toolCtx.dispose();
            this.sessions.delete(sessionId);
            this.broadcast(sessionId, {
              type: 'session_state',
              sessionId,
              messages: currentMessages,
              isRunning: false,
            });
            return;
          }

          // Install the new agent in place.
          managed.agent = built.agent;
          managed.toolCtx = built.toolCtx;
          managed.modelKey = built.modelKey;
          this.wireSubscriptions(managed);
        } catch (err) {
          // The pre-await teardown already disposed the old agent, so
          // we cannot recover it if `buildAgentArtifacts` rejects (e.g.,
          // the user removed the provider's credentials in a parallel
          // tab between message send and model resolve). Evict the
          // zombie entry so the next operation cold-loads from DB;
          // `currentMessages` matches the on-disk transcript (we
          // never persisted anything new in this branch), so DB
          // consistency holds. Re-throw to surface the error to the
          // outer `prompt()` caller, which broadcasts it as `'error'`.
          this.sessions.delete(sessionId);
          throw err;
        } finally {
          managed.rebuildController = undefined;
          // Same finally pattern as retry: if we got here without
          // `agent_start` flipping phase forward, reset to 'idle'.
          if (managed.phase === 'rebuilding') {
            managed.phase = 'idle';
            this.updateKeepAlive();
          }
        }
      }
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

  /**
   * Re-run the last user turn for a session.
   *
   * Drops trailing assistant / toolResult messages after the most recent
   * user message and resumes the agent loop from there. Used by the chat
   * UI's "Retry" button — covers both genuine failures (`stopReason: 'error'`)
   * and successful turns the user is unhappy with.
   *
   * # Lifecycle invariant
   *
   * The `ManagedSession` entry in `this.sessions` stays put throughout the
   * entire rebuild — we mutate its `agent` / `toolCtx` fields in place
   * instead of `delete`-then-`set`. This is the architectural fix for the
   * "stop button stuck after retry" bug: a `cancel()` racing the rebuild
   * window can always locate the entry and abort it via `rebuildController`.
   *
   * # Abort handling
   *
   * `rebuildController.signal` is checked at three boundaries: after the DB
   * flush, after `buildAgentArtifacts`, and after wiring the new agent.
   * If aborted, `handleRebuildAbort` tears down whatever is currently wired
   * (if any), removes the entry from the map (the truncated state is
   * already persisted, so the next operation cold-loads from DB consistently),
   * and broadcasts `session_state { isRunning: false }` so the UI unblocks.
   *
   * No-op if no user message exists in the transcript (defensive throw),
   * or if phase is already non-`idle` (concurrent retry or live run).
   */
  async retry(sessionId: string): Promise<void> {
    // Cold-load if needed. If multiple retry() calls land concurrently for
    // a session not yet in the map, they all await the same in-flight
    // createAgent promise via the `creating` map, then race for the
    // synchronous phase check below. JavaScript's microtask semantics
    // guarantee one of them flips phase to 'rebuilding' before any other
    // awakened microtask reads it — so we don't need a separate mutex.
    const managed = await this.getOrCreateAgent(sessionId);

    if (managed.phase !== 'idle') {
      // Concurrent retry already in flight (`rebuilding`) or agent currently
      // streaming (`running`). Silent no-op so the duplicate window doesn't
      // see a misleading toast — the in-flight run's broadcasts reconcile
      // every subscribed window to the correct state.
      console.debug('[agent-manager] retry: phase not idle, ignored', sessionId, managed.phase);
      return;
    }

    // Take the rebuild slot synchronously, BEFORE any further await. A
    // concurrent retry that wakes up after our await(s) below will hit the
    // phase guard above and bail.
    managed.phase = 'rebuilding';
    managed.rebuildController = new AbortController();
    const signal = managed.rebuildController.signal;
    this.updateKeepAlive();

    try {
      const messages = [...managed.agent.state.messages];
      const truncated = truncateForRetry(messages);
      if (!truncated) {
        // The UI only shows retry on the latest assistant turn, which by
        // definition has a preceding user message. Throwing surfaces the bug
        // instead of silently no-oping.
        throw new Error('No user message found to retry');
      }

      // Persist truncation BEFORE tearing down. SW restart in the rebuild
      // window must not resurrect the failed turn from disk. `flush`
      // collapses the throttler's pending timer and writes immediately.
      if (managed.sessionCreated) {
        sessionStore.scheduleWrite(sessionId, truncated);
        await sessionStore.flush(sessionId);
      }

      // Abort checkpoint 1 — cancel landed during DB flush. The old agent
      // is still wired; let the helper tear it down.
      if (signal.aborted) {
        await this.handleRebuildAbort(managed, truncated, /*hasWiredAgent*/ true);
        return;
      }

      // Tear down the old agent. Defensive `cancelAll` for any pending
      // interactive tool (UI hides retry while pending, but stale port
      // messages could still arrive).
      managed.toolCtx.cancelAll();
      managed.unsubscribeAgent();
      managed.unsubscribeToolCtx();
      managed.toolCtx.dispose();

      // Build the new agent. The internal awaits (model resolve, settings
      // load, tools setup) don't accept an AbortSignal, so we just check
      // `signal.aborted` once after the whole build returns. The cost of an
      // aborted-but-completed build is ~150ms of wasted setup work —
      // acceptable to avoid threading AbortSignal through pi-* APIs.
      const built = await this.buildAgentArtifacts(sessionId, truncated);

      // Abort checkpoint 2 — cancel landed during build. The old agent is
      // already torn down; the new one is built but not wired. Just dispose
      // its tool context (the Agent itself has no listeners and will GC).
      if (signal.aborted) {
        built.toolCtx.dispose();
        await this.handleRebuildAbort(managed, truncated, /*hasWiredAgent*/ false);
        return;
      }

      // Install the new agent in place. `sessionCreated` is preserved by
      // not touching it. The map entry has been continuously in `sessions`
      // throughout this whole flow.
      managed.agent = built.agent;
      managed.toolCtx = built.toolCtx;
      managed.modelKey = built.modelKey;
      this.wireSubscriptions(managed);

      // Abort checkpoint 3 — cancel landed between install and continue.
      // The new agent is now wired; let the helper tear it down.
      if (signal.aborted) {
        await this.handleRebuildAbort(managed, truncated, /*hasWiredAgent*/ true);
        return;
      }

      // Broadcast truncated state with `isRunning: true`. `continue()` is
      // invoked on the very next line and fires `agent_start` on entry,
      // so the agent IS effectively running. Broadcasting `false` here
      // would cause a visible flicker on subscribed windows — briefly
      // re-enabling the composer and breaking the optimistic-running
      // guarantee the hook sets up on click.
      this.broadcast(sessionId, {
        type: 'session_state',
        sessionId,
        messages: truncated,
        isRunning: true,
      });

      // Resume the agent loop against the truncated transcript (last
      // message is user). Fires `agent_start` which flips phase to
      // 'running'; subsequent `agent_end` flips it back to 'idle'.
      await managed.agent.continue();
    } catch (err) {
      // Anything that throws inside the rebuild — the DB flush, the
      // `buildAgentArtifacts` resolve, the subscription wire, the
      // `continue()` call — leaves us with either a half-torn-down
      // managed entry (if the throw was post-teardown) or an entry
      // whose in-memory state may diverge from the freshly-flushed DB.
      // Either way, evicting the entry lets the next operation
      // cold-load consistent state from DB rather than running on a
      // zombie managed reference. The `agent_end` event for an in-flight
      // `continue()` failure normally cleans up via `handleAgentEvent`,
      // but if THAT path itself throws (or never fires because we threw
      // pre-continue), we'd otherwise be stuck. Matches `prompt()`'s
      // model-switch catch.
      this.sessions.delete(managed.sessionId);
      throw err;
    } finally {
      managed.rebuildController = undefined;
      // If the success path ran, agent_start already flipped phase to
      // 'running' (and agent_end will later flip to 'idle'). If we threw
      // or aborted before agent_start, phase is still 'rebuilding' — reset
      // it so the next retry can proceed. Note: when `handleRebuildAbort`
      // (or the catch above) ran, the entry was removed from `sessions`;
      // setting `managed.phase` on a dangling object is harmless and
      // `updateKeepAlive` correctly observes the map state.
      if (managed.phase === 'rebuilding') {
        managed.phase = 'idle';
        this.updateKeepAlive();
      }
    }
  }

  /**
   * Roll back a rebuild that was aborted mid-flight by a user-initiated
   * cancel.
   *
   * Called from `retry()`'s abort checkpoints. Tears down whatever live
   * agent is currently wired onto the entry (if any), appends a synthetic
   * "aborted" assistant marker to the truncated transcript, persists it,
   * removes the entry from `sessions`, and broadcasts `session_state` so
   * subscribed sidepanels show the cancel indicator and re-enable the
   * composer.
   *
   * Why a marker instead of restoring the pre-retry transcript:
   * `cancel` during `phase === 'running'` (post-`continue()`) already
   * yields an aborted-stopReason assistant message naturally — pi-agent-core
   * appends it inside `handleRunFailure`. By mirroring that shape here for
   * the `rebuilding` window, both cancel paths produce the same kind of
   * end-state and the UI only needs one rendering rule for "this turn was
   * cancelled". The marker also prevents the `user, user` consecutive-role
   * transcript that breaks the next LLM call.
   *
   * Marker uses the model object held on the currently-installed agent so
   * api / provider / model fields match what the agent would have produced.
   *
   * Safe to delete from `sessions` here: on a successful flush, DB matches
   * the broadcast and the next operation cold-loads consistent state. On
   * a flush failure (caught and warned) the broadcast still announces the
   * marker; DB lags at the bare truncated state and the user can resend
   * — a degraded but recoverable outcome by design.
   *
   * The cancel that triggered this abort cannot race with our teardown
   * (it only flipped `signal.aborted` and called `agent.abort()`).
   * Unrelated concurrent callers during the `await flush` window ARE
   * possible but harmless: the entry is still in `sessions` with
   * `phase === 'rebuilding'`, so `cancel()` takes its no-side-effect
   * branch and other paths queue behind existing locks.
   *
   * SW-restart during the rebuild is a different scenario: we *don't*
   * run, and DB stays at the bare truncated state. Acceptable because
   * SW-restart is infra-killed and the user didn't ask for a marker —
   * the next interaction will overwrite the transcript anyway.
   */
  private async handleRebuildAbort(
    managed: ManagedSession,
    truncated: AgentMessage[],
    hasWiredAgent: boolean,
  ): Promise<void> {
    if (hasWiredAgent) {
      managed.toolCtx.cancelAll();
      managed.unsubscribeAgent();
      managed.unsubscribeToolCtx();
      managed.toolCtx.dispose();
    }

    const finalMessages: AgentMessage[] = [
      ...truncated,
      this.buildAbortedMarker(managed),
    ];

    if (managed.sessionCreated) {
      sessionStore.scheduleWrite(managed.sessionId, finalMessages);
      try {
        await sessionStore.flush(managed.sessionId);
      } catch (err) {
        console.warn(
          `[agent-manager] flush on rebuild abort failed for ${managed.sessionId}:`,
          err,
        );
        // Continue to broadcast anyway — a DB write failure shouldn't
        // leave the UI stuck with the stop button visible.
      }
    }

    this.sessions.delete(managed.sessionId);
    this.broadcast(managed.sessionId, {
      type: 'session_state',
      sessionId: managed.sessionId,
      messages: finalMessages,
      isRunning: false,
    });
  }

  /**
   * Construct a synthetic `stopReason: 'aborted'` assistant message that
   * mirrors the shape pi-agent-core produces inside `handleRunFailure` when
   * a streaming agent is aborted. Used by `handleRebuildAbort` so cancel
   * during the rebuild window leaves the same kind of marker the running
   * path leaves naturally.
   *
   * Pulls model identity (api / provider / id) off the agent's current
   * state — readable on both the still-wired old agent and the
   * just-installed new agent without needing async model resolution.
   * `usage` is zeroed since no tokens were spent.
   */
  private buildAbortedMarker(managed: ManagedSession): AssistantMessage {
    const model = managed.agent.state.model;
    const marker: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'aborted',
      timestamp: Date.now(),
    };
    return marker;
  }

  /**
   * Cancel an active or in-flight agent for a session.
   *
   * Dispatch by phase:
   *
   * - `rebuilding`: a `retry()` is mid-rebuild. Abort its `rebuildController`
   *   so the next signal checkpoint exits via `handleRebuildAbort`, AND
   *   call `agent.abort()` defensively in case `continue()` has already
   *   been kicked off (the post-checkpoint-3 window after `wireSubscriptions`
   *   but before `agent_start` fires). `agent.abort()` is idempotent — on
   *   a dormant or already-dead agent it's a no-op; on an in-flight agent
   *   it stops the loop and `agent_end` broadcasts naturally through the
   *   handler.
   *
   *   We deliberately do NOT touch `sessions`, dispose, or broadcast here:
   *   `retry()`'s own cleanup flow (either `handleRebuildAbort` for the
   *   pre-`continue()` window or the `agent_end` handler for the
   *   post-`continue()` window) owns those side effects. Duplicating them
   *   from cancel would either flicker the UI between states or double-dispose
   *   a tool context.
   *
   * - `running` / `idle`: standard teardown — abort, unsubscribe, dispose
   *   tool ctx, flush DB, remove from map, broadcast `agent_end`. `idle`
   *   is folded into the same branch so a stale cancel click after an
   *   agent already finished still acts as a session-close (matches
   *   pre-redesign behavior).
   *
   * No-op if no managed entry exists — the session has nothing to cancel
   * (either never started or already cleaned up).
   *
   * Flushes the throttled session writer BEFORE removing the agent from
   * the map so any concurrent `subscribe` / `prompt` for the same id
   * either reuses the still-live in-memory state or reads a fully-persisted
   * DB row — never an interleaved half-flushed snapshot.
   */
  async cancel(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;

    if (managed.phase === 'rebuilding') {
      // Signal the rebuild to bail at its next checkpoint, AND stop the
      // new agent if it has already entered `continue()`. Cleanup and
      // broadcast are retry()'s responsibility — see method JSDoc.
      managed.rebuildController?.abort();
      managed.agent.abort();
      return;
    }

    // phase === 'running' or 'idle' — standard teardown path.
    //
    // Snapshot message-count BEFORE abort so we can tell, after the dust
    // settles, whether pi-agent-core's `handleRunFailure` actually appended
    // a synthetic marker. Without this guard the idle branch (stale stop
    // click on an already-finished agent) would write back identical
    // content and bump `updatedAt`, reordering the session in the history
    // list with no real change.
    const preLen = managed.agent.state.messages.length;
    managed.agent.abort();
    managed.unsubscribeAgent();
    managed.toolCtx.dispose();
    // Wait for the agent's lifecycle to actually settle. `waitForIdle()`
    // resolves to `Promise.resolve()` when there's no active run (idle
    // branch falls through cheaply) and otherwise waits for
    // `runWithLifecycle`'s try/catch/finally to complete — that's the
    // only moment we can be sure pi-agent-core's catch path has finished
    // running `handleRunFailure` and the synthetic `stopReason: 'aborted'`
    // marker is observable on `state.messages`.
    //
    // We previously tried to rely on `sessionStore.flush(...)` as an
    // implicit microtask drain. That assumption was wrong: flush is a
    // near-synchronous no-op when no write is pending (the common case
    // at cancel time), so it does NOT serialize with pi-agent-core's
    // async catch chain. The result was a real race where the snapshot
    // could miss the marker, the explicit persist would then store a
    // bare `[user]` transcript, and the late-arriving marker would land
    // on an orphan agent reference — silently lost. `waitForIdle()` is
    // the API pi-agent-core exposes precisely for this synchronization.
    await managed.agent.waitForIdle();
    // Drain any throttler write scheduled by trailing message_end events
    // from the just-aborted run.
    try {
      await sessionStore.flush(sessionId);
    } catch (err) {
      console.warn(`[agent-manager] flush on cancel failed for ${sessionId}:`, err);
    }
    // Snapshot post-abort state. If pi-agent-core appended the marker,
    // length increased by one; if not (idle branch / no active run),
    // length is unchanged and we skip the redundant write.
    const finalMessages = [...managed.agent.state.messages];
    if (managed.sessionCreated && finalMessages.length !== preLen) {
      sessionStore.scheduleWrite(sessionId, finalMessages);
      try {
        await sessionStore.flush(sessionId);
      } catch (err) {
        console.warn(`[agent-manager] post-abort persist failed for ${sessionId}:`, err);
        // Continue to broadcast anyway — DB lag is recoverable.
      }
    }
    this.sessions.delete(sessionId);
    this.updateKeepAlive();
    // Ensure client knows the agent stopped (abort may not fire agent_end)
    this.broadcast(sessionId, {
      type: 'agent_end',
      sessionId,
      messages: finalMessages,
    });
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

  /** Get current state for a session (for reconnecting clients).
   *
   *  `isRunning` in the returned shape is the external contract (broadcast
   *  in `session_state`, consumed by the sidepanel hook). It's true iff the
   *  agent is actively streaming — `rebuilding` is NOT surfaced as "running"
   *  here because the agent hasn't fired `agent_start` yet; the running flag
   *  is set to true at the retry broadcast site explicitly to keep the UI's
   *  stop button visible across the rebuild window. */
  getSessionState(sessionId: string): { messages: AgentMessage[]; isRunning: boolean } | null {
    const managed = this.sessions.get(sessionId);
    if (!managed) return null;
    return {
      messages: [...managed.agent.state.messages],
      isRunning: managed.phase === 'running',
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

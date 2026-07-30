// 会话管理器（background 单例）——把 agent 绑到一个持久化的对话会话上。
// 持有 `Map<sessionId, AgentSession>`，每个会话有自己的 Agent + SessionToolContext（每会话隔离）。
//
// TODO(架构重构): 当前这个类同时承担了「会话编排 + 消息同步/落库 + 广播 + 单个
// agent 生命周期」四种职责，已接近上帝类（prompt/retry/cancel/maybeCompact 都几百行）。
// 计划把「单次 agent 运行的生命周期」（agent + toolCtx + phase + controllers，以及
// 单次运行的 prompt/retry/cancel/compaction）抽成独立的 `AgentRun`，本类只留下跨会话
// 的编排：creating 去重、keep-alive、MCP 订阅、DB gating、viewer 广播。
// （不叫 AgentSession：与本文件里的「会话」概念撞词。）
// 前置条件：先完成 rebuilding 简化（retry 原地复用活 agent，退役 rebuilding phase），
// 让单次运行的生命周期变干净后再拆，避免「边拆边改逻辑」。详见讨论记录。

import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  estimateContextTokens,
  shouldCompact,
} from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import { clampThinkingLevel } from '@earendil-works/pi-ai';
import { createCebianAgent } from '../agent/factory';
import { composeUserMessage, composeSystemPrompt } from '../agent/prompt-composer';
import { resolveProviderApiKey } from '../providers/credentials';
import {
  COMPACTION_SETTINGS,
  findCompactionCutPoint,
  runCompaction,
  createCompactionSummaryMessage,
  isCompactionSummary,
  usableCompactionTarget,
  type CompactionSummaryMessage,
  type CompactionTarget,
} from '@/lib/agent/compaction';
import { sessionStore } from './session-store';
import { extractImages, type Attachment } from '@/lib/agent/attachments';
import { createSessionTools, buildSessionToolArray } from '@/lib/tools';
import { runSkillGate } from '@/lib/tools/run-skill';
import type { SessionToolContext } from '@/lib/tools/session-context';
import {
  createInteractiveBridge,
  INTERACTIVE_CANCELLED,
  type InteractiveBridge,
} from '@/lib/tools/interactive-bridge';
import {
  createPermissionGate,
  createPermissionRequestMessage,
  isPermissionRequest,
  type PermissionRequest,
  type PermissionDecision,
  type ToolGate,
} from '@/lib/agent/tool-permissions';
import type { TurnSettings } from '@/lib/ipc/protocol';
import type { SessionRecord } from '@/lib/persistence/db';
import { truncateForRetry, sanitizeAgentMessages } from '@/lib/agent/message-helpers';
import {
  providerCredentials,
  customProviders as customProvidersStorage,
  lastSelectedModel,
  compactionModel,
  lastSelectedThinkingLevel,
  userInstructions as userInstructionsStorage,
  memorySettings,
  type ModelIdentity,
  type ThinkingLevel,
} from '@/lib/persistence/storage';
import { getMCPManager } from '@/lib/mcp/manager';
import { resolveModel } from '@/lib/providers/resolve-model';
import { t } from '@/lib/i18n';
import { acquireKeepAlive, releaseKeepAlive } from '../lifecycle/keepalive';
import { broadcastToViewers } from './viewers';

// ─── Types ───

/**
 * Lifecycle phase of an `AgentSession`.
 *
 * - `idle`: agent exists but is not running — waiting for next prompt/retry.
 *   This is the initial state and the resting state after `agent_end`.
 * - `preparing`: a `retry()` has been accepted and the session is doing async
 *   preparation before the agent resumes streaming — refreshing
 *   model / instructions / messages off storage. The `AgentSession`
 *   entry stays in `sessions` throughout this phase so external operations
 *   (notably `cancel`) can still reach it. This phase only ever moves forward
 *   to `running` (via the `agent_start` event) or back to `idle` (on
 *   cancel / error) — never the reverse. (A model switch refreshes the live
 *   agent in place during `prompt()` without entering this phase — it has no
 *   independent resume/cancel window.)
 * - `running`: the agent is actively streaming a turn. Set by the
 *   `agent_start` event, cleared by `agent_end`.
 * - `compacting`: a context-compaction step is running before a fresh turn
 *   is dispatched — an independent `generateSummary` LLM call that may take
 *   several seconds. Entered by `maybeCompact()` right before `agent.prompt()`
 *   when the context exceeds the threshold; reset back to `idle` in that
 *   method's `finally`. Treated as "busy" everywhere (`updateKeepAlive`,
 *   `getSessionState`, the prompt guard) so the SW stays alive and concurrent
 *   prompts are dropped, mirroring the `preparing` window.
 *
 * Invariant: a session entry is in `sessions` iff its lifetime hasn't ended.
 * The previous design temporarily evicted entries during rebuild, which
 *  made `cancel()` silently no-op when it raced the preparation window — that
 * is exactly the bug this phase machine fixes.
 */
type AgentPhase = 'idle' | 'preparing' | 'running' | 'compacting';

/**
 * 注册了执行前授权门禁的工具策略（ToolGate）集合。policy 对象本身是
 * session-independent 的纯策略，所以放模块级单一来源；每个会话只是用它
 * 构造一个绑定到自身 `requestPermissionDecision` 的 `beforeToolCall` 闭包。
 *
 * 目前只有 run_skill 接入；未来 chrome_api / execute_js 等要执行前授权时，
 * 在各自工具文件里实现 ToolGate 并加进这个数组即可，本编排层零改动。
 */
const PERMISSION_GATES: ToolGate[] = [runSkillGate];

interface AgentSession {
  agent: Agent;
  sessionId: string;
  sessionCreated: boolean;
  phase: AgentPhase;
  /**
   * Set while `phase === 'preparing'`. `cancel()` aborts this signal to
   * interrupt a retry's async preparation; the retry path checks `signal.aborted`
   * at each await boundary and bails cleanly without calling `agent.continue()`.
   * Cleared back to `undefined` when preparation ends (either success or abort).
   */
  prepareController?: AbortController;
  /**
   * Set while `phase === 'compacting'`. `cancel()` aborts this signal to
   * interrupt an in-flight `generateSummary` call; `maybeCompact()` then
   * skips inserting the summary, resets the phase, and signals `prompt()`
   * to abandon the turn. Cleared back to `undefined` when compaction ends.
   */
  compactionController?: AbortController;
  modelKey: string;
  /** Unified interactive tool bridge manager for this session. */
  toolCtx: SessionToolContext;
  /**
   * Per-session bridge for tool pre-execution permission prompts. Kept
   * separate from `toolCtx` because a permission prompt is NOT an LLM tool —
   * it pauses an otherwise-normal tool inside its `beforeToolCall` gate and
   * uses the dedicated permission broadcast path, not `tool_pending`.
   * At most one request is in-flight at a time (gate preflight is sequential).
   */
  permissionBridge: InteractiveBridge<PermissionRequest, PermissionDecision>;
  unsubscribeAgent: () => void;
}

// ─── Session Manager ───

class SessionManager {
  private sessions = new Map<string, AgentSession>();
  /** Guards against concurrent getOrCreateAgent calls for the same session. */
  private creating = new Map<string, Promise<AgentSession>>();
  /** True iff we're currently holding a SW keep-alive token. Tracked so
   *  acquire/release stay balanced even across error paths. */
  private keepAliveHeld = false;
  /** Subscription to MCPManager change notifications; pushes refreshed tools into every live session. */
  private mcpUnsubscribe?: () => void;

  /**
   * 订阅 MCPManager 变更，把刷新后的工具集推给所有活跃会话。由 background 启动序列
   * 调用一次；幂等
   */
  watchMCPTools(): void {
    // Subscribe to MCPManager so we react AFTER its internal entries map is
    // reconciled — avoids racing two independent storage watchers.
    if (!this.mcpUnsubscribe) {
      this.mcpUnsubscribe = getMCPManager().subscribe(() => {
        void this.refreshAllSessionTools();
      });
    }
  }

  private getPendingToolSnapshot(agentSession: AgentSession): { toolName: string; toolCallId: string; args: any }[] {
    return agentSession.toolCtx.getPendingRequests().map(({ toolName, pending }) => ({
      toolName,
      toolCallId: pending.toolCallId,
      args: pending.request,
    }));
  }

  /** Snapshot of the session's in-flight permission prompt (0 or 1). */
  private getPendingPermissions(agentSession: AgentSession): PermissionRequest[] {
    const pending = agentSession.permissionBridge.getPending();
    return pending ? [pending.request] : [];
  }

  /**
   * Broadcast a full `session_state` snapshot for the session. Used by the
   * permission flow to push the inserted / updated `permissionRequest` card
   * plus the live `pendingPermissions` set in one shot — mirroring how
   * `maybeCompact` delivers an inserted `compactionSummary`.
   */
  private broadcastSessionSnapshot(agentSession: AgentSession): void {
    broadcastToViewers(agentSession.sessionId, {
      type: 'session_state',
      sessionId: agentSession.sessionId,
      messages: [...agentSession.agent.state.messages],
      isRunning: agentSession.phase !== 'idle',
      isCompacting: agentSession.phase === 'compacting',
      pendingTools: this.getPendingToolSnapshot(agentSession),
      pendingPermissions: this.getPendingPermissions(agentSession),
    });
  }

  /**
   * 落库本会话的消息——**写会话 transcript 的唯一入口**。全类每一处 transcript
   * 变更都经此，使将来把存储换成会话树（entry 追加）时只需改这一处。
   *
   * 只在构造本会话时确实读到了会话行（`sessionCreated`）才写。底层走
   * `db.sessions.update()`，行不存在时它是静默 no-op，故这个守卫不是为了防凭空
   * 造行，而是为了不对「已知没有行」的会话发起无用的节流写（它会建一个永远写不
   * 进去的 writer）。
   *
   * 只管「排写」：刷盘（`flush`）与广播留在各调用点——它们的策略确有差异
   *（压缩成功路径 flush 失败即抛，取消路径则警告并继续），而排写这一步完全同质。
   *
   * @returns 是否真的排了写。调用方据此决定要不要紧跟着 flush：没排写就别 flush，
   *          避免去刷一个不属于本次变更的遗留 writer。
   */
  private persist(agentSession: AgentSession, messages: AgentMessage[]): boolean {
    if (!agentSession.sessionCreated) return false;
    sessionStore.scheduleWrite(agentSession.sessionId, messages);
    return true;
  }

  /**
   * Injected as the permission gate's `RequestDecisionFn`. Runs while a tool
   * is paused in its `beforeToolCall` gate (loop is suspended here).
   *
   * Flow: insert a `pending` permissionRequest message → persist + broadcast →
   * await the user's click on the bridge → write the final decision back onto
   * that message → persist + broadcast → return the decision to the gate.
   *
   * The inserted message lands between the assistant(toolCall) and the
   * (not-yet-produced) toolResult — exactly the order needed so `convertToLlm`
   * filtering keeps toolCall↔toolResult adjacent for the provider.
   *
   * Terminal mapping: an explicit `bridge.resolve(decision)` returns that
   * decision; a `bridge.cancel()` / abort (user sent a new message, or the
   * session is being torn down) surfaces `INTERACTIVE_CANCELLED` → `dismissed`.
   */
  private async requestPermissionDecision(
    sessionId: string,
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    const agentSession = this.sessions.get(sessionId);
    // No live session (shouldn't happen — gate fires only for a live agent),
    // fail closed as dismissed so the tool does not execute.
    if (!agentSession) return 'dismissed';

    // ① 插入 pending 卡片消息（setter 赋值，与 compaction 同款）。
    agentSession.agent.state.messages = [
      ...agentSession.agent.state.messages,
      createPermissionRequestMessage(request),
    ];

    // ② 先发起 bridge 请求——它会**同步**置上 pending（Promise executor 同步执行），
    // 这样紧接着的 broadcast 才能在 pendingPermissions 里带上本次请求。若先广播
    // 再 request，那一帧 pendingPermissions 会是空的，UI 会把刚插入的卡片误判为
    // 已失效（失效判定 = toolCallId 不在活 pending 快照里）。
    const decisionPromise = agentSession.permissionBridge.request(request.toolCallId, request, signal);
    this.persist(agentSession, [...agentSession.agent.state.messages]);
    this.broadcastSessionSnapshot(agentSession);

    // ③ 等用户在卡片上点击（或被取消 / abort）。
    const result = await decisionPromise;
    const decision: PermissionDecision =
      result === INTERACTIVE_CANCELLED ? 'dismissed' : result;

    // 会话在等待期间被销毁 / 替换：放弃回写与广播，避免复活已删会话行。
    if (this.sessions.get(sessionId) !== agentSession) return decision;

    // ④ 把最终决策回写到那条 pending 卡片上（按 toolCallId 定位）。
    agentSession.agent.state.messages = agentSession.agent.state.messages.map((m) =>
      isPermissionRequest(m) && m.toolCallId === request.toolCallId
        ? { ...m, decision }
        : m,
    );
    this.persist(agentSession, [...agentSession.agent.state.messages]);
    this.broadcastSessionSnapshot(agentSession);

    return decision;
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
      Array.from(this.sessions.values()).map(async (agentSession) => {
        try {
          const tools = await buildSessionToolArray(agentSession.toolCtx);
          agentSession.agent.state.tools = tools;
        } catch (err) {
          console.warn(`[mcp] failed to refresh tools for session ${agentSession.sessionId}:`, err);
        }
      }),
    );
  }

  /**
   * Acquire / release a SW keep-alive token based on whether any session
   * has active work in flight. Counts both `running` (agent streaming) and
   * `preparing` (a retry's async setup) so the SW doesn't suspend
   * mid-preparation — a suspension there would leave the session with
   * phase='preparing' but no actual work in flight, since phase is in-memory
   * state.
   *
   * Uses the shared ref-counted helper in `lifecycle/keepalive.ts` so multiple
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

  /** 是否有任一会话非 idle。供自动整理调度的 idle 门控：有活跃对话则不自动整理。 */
  hasActiveSession(): boolean {
    return [...this.sessions.values()].some((s) => s.phase !== 'idle');
  }

  /**
   * 解析「本会话该用哪个模型」成 pi-ai 运行时 `Model`。读存储（凭据 + 自定义 provider）
   * 后委托纯函数 `resolveModel`。
   *
   * `identity` 是「本会话的模型身份」——来自会话行或 prompt/retry 携带值；缺省（undefined）
   * 时回退到全局 `lastSelectedModel` 充当「新对话默认种子」（向后兼容：旧消息 / 旧会话行
   * 无模型时仍能解析）。解析失败返回 null，由调用方诚实报错。
   */
  private async resolveSessionModel(
    identity?: ModelIdentity,
  ): Promise<{ model: Model<Api>; provider: string; modelId: string } | null> {
    const [globalModel, creds, customProvs] = await Promise.all([
      identity ? Promise.resolve(null) : lastSelectedModel.getValue(),
      providerCredentials.getValue(),
      customProvidersStorage.getValue(),
    ]);
    const modelCfg = identity ?? globalModel;
    if (!modelCfg) return null;

    const model = resolveModel(modelCfg, creds, customProvs ?? []);
    if (!model) return null;

    return { model, provider: modelCfg.provider, modelId: modelCfg.modelId };
  }

  /**
   * 解析压缩（摘要）该用哪个模型 + 凭证。读全局 `compactionModel` 配置：
   * - 未配置（null）→ 跟随主模型 `fallback`（默认语义）。
   * - 配置了但解析不出（模型被删 / provider 没了）或无可用凭证 → console.warn
   *   后静默回退主模型。压缩是后台增益，绝不因配错而中断本轮发送。
   *
   * 返回 `{ model, apiKey }`；apiKey 可能为 undefined（连主模型都无凭证），由
   * maybeCompact 现有的「无 key 则裸发」分支处理。
   */
  private async resolveCompactionModel(fallback: Model<Api>): Promise<CompactionTarget> {
    const configuredId = await compactionModel.getValue();
    if (configuredId) {
      const resolved = await this.resolveSessionModel(configuredId);
      if (!resolved) {
        console.warn('[compaction] configured model cannot be resolved (possibly deleted), falling back to main model', configuredId);
      } else {
        const apiKey = await resolveProviderApiKey(resolved.model.provider);
        const usable = usableCompactionTarget({ model: resolved.model, apiKey });
        if (usable) return usable;
        console.warn('[compaction] configured model has no usable credentials, falling back to main model', configuredId);
      }
    }
    // 回退主模型（未配置 / 解析失败 / 无凭证）：此刻才解析主模型凭证，避免配置可用时
    // 对主 provider 做无谓的 OAuth 刷新。
    return { model: fallback, apiKey: await resolveProviderApiKey(fallback.provider) };
  }

  /** Get or create the `AgentSession` for a session id */
  private async getOrCreateAgent(sessionId: string): Promise<AgentSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    // Guard against concurrent creation
    const pending = this.creating.get(sessionId);
    if (pending) return pending;

    const promise = this.createAgent(sessionId);
    this.creating.set(sessionId, promise);
    try {
      const agentSession = await promise;
      return agentSession;
    } finally {
      this.creating.delete(sessionId);
    }
  }

  /**
   * 创建并安装一个 `AgentSession`（每会话仅一次，由 `getOrCreateAgent` 的 `creating`
   * 去重守卫）。流程：加载会话行（本会话模型 / 思考档的真相来源）→ 解析模型 →
   * 造每会话独立工具 + 授权 bridge → 一次成形 systemPrompt → 构造 Agent → wire 订阅
   * → 入 map。
   *
   * 到达这里时会话行一定已存在：brand-new 会话的行由 prompt() 在本函数前写好（带本轮
   * 携带的选择），已有会话的行带它自己存的选择。in-place 的 retry / 切模型路径复用活
   * agent，不走这里。
   */
  private async createAgent(sessionId: string): Promise<AgentSession> {
    // 会话行 = 本会话模型 / 思考档的真相来源。
    const existingSession = await sessionStore.load(sessionId);
    // sessionStore.load 已把历史整形回类型契约（issue #43），此处拿到的即干净数据
    const messages: AgentMessage[] = existingSession?.messages ?? [];
    const sessionCreated = !!existingSession;

    // 从会话行自己的模型身份解析（而非全局 lastSelectedModel）。行里没有可用模型（空串 /
    // 旧备份恢复来的）时传 undefined，让 resolveSessionModel 回退全局；仍解析不出则
    // throw（诚实报错，让用户重选），与 prompt / retry 三路一致。
    const sessionIdentity: ModelIdentity | undefined =
      existingSession?.provider && existingSession?.model
        ? { provider: existingSession.provider, modelId: existingSession.model }
        : undefined;
    const resolved = await this.resolveSessionModel(sessionIdentity);
    if (!resolved) throw new Error('No model selected or model not found');

    const thinkingLvl = existingSession?.thinkingLevel || (await lastSelectedThinkingLevel.getValue());

    // 每会话独立的工具 + bridge。
    const { tools: sessionTools, ctx: toolCtx } = await createSessionTools(sessionId);

    // 工具执行前授权门禁：每会话一个独立 bridge；用它构造绑定到本会话
    // `requestPermissionDecision` 的 beforeToolCall 闭包。requestDecision 在
    // gate 真正触发时才按 sessionId 反查 `AgentSession`（那时一定已入 map），因此
    // 这里不构成与 agent / AgentSession 的循环依赖。
    const permissionBridge = createInteractiveBridge<PermissionRequest, PermissionDecision>();
    const beforeToolCall = createPermissionGate(
      PERMISSION_GATES,
      (request, signal) => this.requestPermissionDecision(sessionId, request, signal),
    );

    // systemPrompt 一次成形（含 skills 索引 + 用户指令）。composeSystemPrompt 是
    // systemPrompt 的单一来源，与切模型 / retry / 派发前刷新走同一条路径，保证四处
    // 产出逐字节一致。
    const systemPrompt = await composeSystemPrompt(sessionId);

    // 档位夹到该模型支持范围：off→强制思考模型取最低支持档、超限档取上限、未知值兜底，
    // 保证实际发出的 effective 档与 ChatInput 的 displayThinkingLevel 一致
    const agent = createCebianAgent({
      model: resolved.model,
      systemPrompt,
      thinkingLevel: clampThinkingLevel(resolved.model, (thinkingLvl || 'medium') as ThinkingLevel),
      messages,
      tools: sessionTools,
      beforeToolCall,
    });

    const agentSession: AgentSession = {
      agent,
      sessionId,
      sessionCreated,
      phase: 'idle',
      modelKey: `${resolved.provider}/${resolved.modelId}`,
      toolCtx,
      permissionBridge,
      unsubscribeAgent: () => {},
    };
    this.wireSubscriptions(agentSession);
    this.sessions.set(sessionId, agentSession);
    return agentSession;
  }

  /**
   * Wire agent + toolCtx event subscriptions into an `AgentSession`.
   *
   * Only ever called once per entry, from `createAgent` — the in-place
   * retry / model-switch paths reuse the live agent and toolCtx, so there is
   * no re-wiring. The toolCtx listener is intentionally fire-and-forget:
   * every teardown path (`cancel`, `destroySession`) calls `toolCtx.dispose()`,
   * which clears its listeners, so we don't keep a separate unsubscribe handle
   * for it. The agent listener does keep `unsubscribeAgent` because teardown
   * detaches it explicitly before disposing.
   *
   * The subscription callbacks close over `agentSession`, so the agent / toolCtx
   * fields stay reachable as the object's own properties — there is no stale
   * closure problem.
   */
  private wireSubscriptions(agentSession: AgentSession): void {
    agentSession.unsubscribeAgent = agentSession.agent.subscribe(async (event: AgentEvent) => {
      await this.handleAgentEvent(agentSession, event);
    });
    agentSession.toolCtx.subscribe((toolName, pending) => {
      if (pending) {
        broadcastToViewers(agentSession.sessionId, {
          type: 'tool_pending',
          sessionId: agentSession.sessionId,
          toolName,
          toolCallId: pending.toolCallId,
          args: pending.request,
        });
      } else {
        broadcastToViewers(agentSession.sessionId, {
          type: 'tool_resolved',
          sessionId: agentSession.sessionId,
          toolName,
        });
      }
    });
  }

  private async handleAgentEvent(agentSession: AgentSession, event: AgentEvent): Promise<void> {
    const { sessionId, agent } = agentSession;

    switch (event.type) {
      case 'agent_start':
        // Any path that calls `agent.continue()` / `agent.prompt()` ends up
        // here — including retry, which leaves phase='preparing' until this
        // event flips it forward to 'running'. Direct prompt() entries go
        // 'idle' → 'running'; both transitions are valid and collapse to a
        // single line.
        //
        // 状态机硬约束：进入 running 的唯一入口就是本事件，且只能从
        // preparing / idle 前进（preparing → running 单向不可逆）。其他
        // 任何地方不准手动置 running；这里断言锁死方向。
        if (agentSession.phase !== 'preparing' && agentSession.phase !== 'idle') {
          console.warn(
            `[session-manager] agent_start from unexpected phase '${agentSession.phase}' for ${sessionId}`,
          );
        }
        agentSession.phase = 'running';
        broadcastToViewers(sessionId, { type: 'agent_start', sessionId });
        this.updateKeepAlive();
        break;

      case 'message_update':
        if (event.message.role === 'assistant') {
          broadcastToViewers(sessionId, {
            type: 'message_update',
            sessionId,
            message: event.message,
          });
        }
        break;

      case 'message_end': {
        const messages = [...agent.state.messages];
        broadcastToViewers(sessionId, { type: 'message_end', sessionId, messages });
        this.persist(agentSession, messages);
        break;
      }

      case 'agent_end': {
        agentSession.phase = 'idle';
        this.updateKeepAlive();
        // Cancel any pending interactive tools on this session
        agentSession.toolCtx.cancelAll();
        // 同理取消在途的授权请求（→ dismissed），否则 run 结束后 gate 还在
        // await 一个永不到来的点击。
        agentSession.permissionBridge.cancel();
        const messages = [...agent.state.messages];
        broadcastToViewers(sessionId, { type: 'agent_end', sessionId, messages });
        // Persist final state before flushing. Normally the trailing
        // `message_end` already scheduled a write with the same content,
        // but pi-agent-core's `handleRunFailure` (abort/error path) appends
        // a synthetic assistant marker straight to `state.messages` and
        // fires `agent_end` without a preceding `message_end` — so without
        // this schedule the marker reaches the session's viewers via the
        // broadcast above but never lands in DB, and disappears on the
        // next cold-load. The scheduler is idempotent for unchanged
        // content so this is safe to call unconditionally on every
        // agent_end.
        this.persist(agentSession, messages);
        await sessionStore.flush(sessionId);
        break;
      }
    }
  }

  /** Send a prompt to the agent for a session.
   *
   *  `turn` 是页面随本条消息携带的「本次发送所用的模型 / 思考档」——属于该会话
   *  的选择。新会话据它建行；已有会话据它就地刷新活 agent 并落库到会话行（会话
   *  行是真相）。缺省时回退全局 lastSelectedModel 充当「新对话默认种子」（向后兼容）。 */
  async prompt(
    sessionId: string,
    text: string,
    attachments: Attachment[] = [],
    turn?: TurnSettings,
  ): Promise<void> {
    // Persist + broadcast 'session_created' for brand-new sessions BEFORE any
    // agent setup work (model resolve, tool factory, MCP, createAgent — easily
    // several hundred ms). Without this the UI stays on /chat/new with an empty
    // title and a no-op "new chat" button until the first agent_start arrives.
    //
    // Detection: not in the live sessions map AND no DB record. The DB record
    // we write here is what getOrCreateAgent's sessionStore.load() will find,
    // so `agentSession.sessionCreated` is set to true by createAgent() naturally,
    // and we don't need a second persist-and-broadcast inside this method.
    if (!this.sessions.has(sessionId)) {
      const existing = await sessionStore.load(sessionId);
      if (!existing) {
        const [globalModel, instructions, globalThinking] = await Promise.all([
          lastSelectedModel.getValue(),
          userInstructionsStorage.getValue(),
          lastSelectedThinkingLevel.getValue(),
        ]);
        // 建行用本轮携带的 turn；缺省回退全局种子。模型仍为空则拒绝建行
        // （否则后续 getOrCreateAgent 会 throw，留下一条空模型的孤儿会话行）。
        const modelCfg = turn?.model ?? globalModel;
        const thinkingLvl = turn?.thinkingLevel ?? globalThinking;
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
          broadcastToViewers(sessionId, {
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

    const agentSession = await this.getOrCreateAgent(sessionId);

    if (agentSession.phase === 'preparing' || agentSession.phase === 'compacting') {
      // A retry's preparation OR a compaction is already in flight for this
      // session. The UI gates the composer to prevent concurrent prompts,
      // but a stale or out-of-order IPC could still arrive — dispatching a
      // fresh turn now would race the in-flight `continue()` / compaction and
      // corrupt the phase machine. Silently dropping matches `retry()`'s
      // phase-guard pattern; the in-flight work's broadcasts reconcile every
      // viewing window to the correct state.
      console.debug('[session-manager] prompt: phase busy, ignored', sessionId, agentSession.phase);
      return;
    }

    // 模型 / 思考档切换检测：以本轮携带的 turn 为准（而非全局）。model 与
    // thinkingLevel 在协议里各自可选，故分别判断、分别落库——只要任一项变了就刷新活
    // agent 并把变的字段写回会话行（会话行是真相）。turn 缺省（旧客户端不带）时整段
    // 跳过，活 agent 保持会话选择不动。
    if (turn) {
      const turnKey = turn.model
        ? `${turn.model.provider}/${turn.model.modelId}`
        : null;
      const modelChanged = turnKey != null && turnKey !== agentSession.modelKey;
      if (modelChanged) {
        // 就地刷新活 agent。与 retry 不同，这里没有 resume/cancel 窗口：换字段是同步
        // 赋值，下面正常派发会触发 agent_start，故不进 preparing、不挂 controller。
        // `resolveSessionModel` 按 turn 身份解析（自定义 provider 查表 / copilot OAuth
        // baseUrl / openrouter 头一致）。解析失败（模型被删 / 凭据被并行 tab 拔掉）则
        // throw，与 createAgent / retry 三路一致地诚实报错。
        const resolved = await this.resolveSessionModel(turn.model);
        if (!resolved) throw new Error('No model selected or model not found');
        agentSession.agent.state.model = resolved.model;
        agentSession.modelKey = turnKey!;
      }
      // 思考档：把 turn 携带的原始偏好对（可能刚换的）当前模型夹成 effective 档，只有
      // effective 变了才更新 + 落库。这样「只换模型、档位没跟着换但新模型不支持现档」也会
      // 重夹（如切到强制思考模型，off→最低支持档）；而原始 'max' 在只到 'high' 的模型上夹成
      // 'high' 不算变化，避免每轮空写。落库写已夹的 effective 档；原始高档偏好留在全局种子，
      // 各读取点（createAgent / seedTurnFromSession）都会再按模型 clamp
      const nextThinking = turn.thinkingLevel != null
        ? clampThinkingLevel(agentSession.agent.state.model, turn.thinkingLevel)
        : null;
      const thinkingChanged = nextThinking != null && nextThinking !== agentSession.agent.state.thinkingLevel;
      if (thinkingChanged) {
        agentSession.agent.state.thinkingLevel = nextThinking!;
      }
      // 落库到会话行——会话行是真相来源。只写变了的字段；全都没变则不调 updateSettings。
      if (agentSession.sessionCreated && (modelChanged || thinkingChanged)) {
        await sessionStore.updateSettings(sessionId, {
          provider: modelChanged ? turn.model!.provider : undefined,
          model: modelChanged ? turn.model!.modelId : undefined,
          thinkingLevel: thinkingChanged ? agentSession.agent.state.thinkingLevel : undefined,
        });
      }
    }

    // 本轮记忆开关的单一快照：同时喂给 user 消息注入与 system prompt 刷新，
    // 保证一轮内两处读同一个值（原子门控，避免读到两个快照而前后不一致）。
    const memoryEnabled = (await memorySettings.getValue()).enabled;
    const enriched = await composeUserMessage(text, attachments, memoryEnabled);

    const images = extractImages(attachments);

    // Liveness guard. Everything from `getOrCreateAgent` down to the dispatch
    // below runs while `phase === 'idle'` (model resolve, settings reads,
    // `composeUserMessage` — the latter can be slow for image
    // attachments). A `cancel()` landing in that window takes its idle
    // teardown branch (abort + dispose + `sessions.delete`), leaving `agentSession`
    // detached. Dispatching now would steer/prompt a disposed agent, waste an
    // API call, and let `maybeCompact`'s persist resurrect the deleted row.
    // If the entry is gone (or was replaced), the user already stopped this
    // turn — bail; `cancel()` already broadcast the authoritative end state.
    if (this.sessions.get(sessionId) !== agentSession) return;

    const refreshedSystemPrompt = await composeSystemPrompt(sessionId, memoryEnabled);
    if (this.sessions.get(sessionId) !== agentSession) return;
    agentSession.agent.state.systemPrompt = refreshedSystemPrompt;

    // If any interactive tool OR a permission prompt is pending, the agent is
    // paused waiting for the user — steer the new message into the loop and
    // cancel the pending prompt instead of starting a fresh turn. A cancelled
    // permission prompt surfaces as `dismissed` (implicit non-grant), which
    // blocks the gated tool; the steered message then drives the next turn.
    if (agentSession.toolCtx.hasPending() || agentSession.permissionBridge.getPending()) {
      const content: any[] = [{ type: 'text', text: enriched }];
      if (images.length > 0) content.push(...images);
      const userMessage: AgentMessage = {
        role: 'user',
        content,
        timestamp: Date.now(),
      } as AgentMessage;
      // Enqueue BEFORE cancelling so getSteeringMessages() sees it when the loop drains.
      agentSession.agent.steer(userMessage);
      agentSession.toolCtx.cancelAll();
      agentSession.permissionBridge.cancel();
    } else {
      // 构造本轮「待投递」的用户消息，形状对齐 steering 分支。压缩成功路径不会
      // 用它（由 agent.prompt() 自行 append 真实用户消息），它只用于压缩期间的
      // 广播展示，以及压缩中取消时补进 state 充当「已取消」前的那条用户气泡。
      const pendingContent: any[] = [{ type: 'text', text: enriched }];
      if (images.length > 0) pendingContent.push(...images);
      const pendingUserMessage: AgentMessage = {
        role: 'user',
        content: pendingContent,
        timestamp: Date.now(),
      } as AgentMessage;

      // Before a fresh turn, compact the transcript if the context is over
      // threshold (state layer: generate + insert summary + persist +
      // broadcast). Gated on `phase === 'idle'`: a stale prompt arriving
      // mid-run (phase 'running', no pending tool) must NOT enter compaction
      // and clobber the phase machine — compaction is strictly a
      // start-of-turn step. Returns true iff the compaction was cancelled
      // mid-flight, in which case the user's stop click means we abandon this
      // turn and don't dispatch to the model.
      if (agentSession.phase === 'idle') {
        const cancelled = await this.maybeCompact(agentSession, pendingUserMessage);
        if (cancelled) return;
      }
      await agentSession.agent.prompt(enriched, images.length > 0 ? images : undefined);
    }
  }

  /**
   * Compact the session transcript before a fresh turn when the context
   * exceeds the configured threshold.
   *
   * Lossless design: the original messages stay in
   * `agent.state.messages` forever — we only *insert* a `compactionSummary`
   * marker at a turn-start boundary. The LLM-facing fold (keep only the last
   * summary + everything after it) happens later in `transformContext`; this
   * method never drops history.
   *
   * Flow:
   * 1. Estimate context tokens (last assistant `usage.totalTokens` +
   *    trailing char/4) and bail if under threshold.
   * 2. Find a cut point aligned to a user turn-start (excludes toolResult
   *    mid-turn — this is the root-cause fix for issue #9's orphan toolResult
   *    → provider 400).
   * 3. Roll the summary: the summarized region is the delta *since the
   *    last summary*, and the previous summary text is fed to `generateSummary`
   *    as `previousSummary` for an UPDATE-style merge. Multiple summaries
   *    accumulate physically; `transformContext` only ever sends the last one.
   * 4. On success, splice the new summary right before the cut user message
   *    and persist. On failure (after one internal retry), skip the
   *    summary and send anyway — the turn-start-aligned cut guarantees no 400.
   *
   * Concurrency: runs under `phase === 'compacting'` with a dedicated
   * `compactionController`. `cancel()` aborts it; the top-of-`prompt()` guard
   * drops concurrent prompts. Keep-alive is held automatically because
   * `phase !== 'idle'`.
   *
   * @param pendingUserMessage 本轮「待投递」的用户消息。压缩成功不消费它；压缩中
   *        被取消时由 `commitCompactionCancel` 把它连同 aborted 标记补进 state，
   *        使取消后界面与普通取消一致（用户气泡 + 「已取消」）。
   * @returns `true` iff the compaction was cancelled and the caller should
   *          abandon the turn; `false` otherwise (no-op skip or success).
   */
  private async maybeCompact(agentSession: AgentSession, pendingUserMessage: AgentMessage): Promise<boolean> {
    if (!COMPACTION_SETTINGS.enabled) return false;

    const { sessionId } = agentSession;
    // 估算 / 切点 / 摘要 / 回写都基于这份消息：先整形回类型契约（null text/thinking/name
    // → ''），否则 estimateContextTokens / findCompactionCutPoint 对 assistant 块取 .length
    // 会崩（issue #43）。copy-on-write：无坏数据时返回同一引用、零分配（仅一次线性扫描）；
    // 有坏数据时顺带把治好的版本随摘要回写进 state
    const messages = sanitizeAgentMessages(agentSession.agent.state.messages);
    const model = agentSession.agent.state.model;

    // token 估算：优先读最后一条 assistant 的真实 usage，尾部按 char/4 估算。
    const { tokens } = estimateContextTokens(messages);
    if (!shouldCompact(tokens, model.contextWindow, COMPACTION_SETTINGS)) return false;

    // 切点对齐到 user turn-start（排除 toolResult 中间），修 issue #9。
    const cut = findCompactionCutPoint(messages, COMPACTION_SETTINGS.keepRecentTokens);

    // 滚动摘要：定位上一条摘要，待摘要区间是「上一条摘要之后 → 新切点」的增量
    //（更早的历史已被旧摘要覆盖，无需重复总结），旧摘要文本作为 previousSummary
    // 喂给 generateSummary 做 UPDATE 合并。
    let lastSummaryIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isCompactionSummary(messages[i])) {
        lastSummaryIdx = i;
        break;
      }
    }
    // baseIdx：上一条摘要之后的起点；为 0 表示尚无摘要。
    const baseIdx = lastSummaryIdx + 1;

    // 切点未越过「上一条摘要之后」→ 自上次压缩以来没有新的可摘要历史，跳过。
    if (cut <= baseIdx) return false;

    // 进入 compacting 阶段：占用非 idle 状态（自动保活 + 阻止并发 prompt）。
    // 这一步在「任何 await 之前」同步完成，把可取消的忙碌态原子地占住——否则在
    // 解析 apiKey 的 await 窗口里若发生 cancel，会落进 idle 分支拆掉会话，导致
    // 本方法事后往已删除的会话写入并广播（评审指出的竞态）。
    agentSession.phase = 'compacting';
    agentSession.compactionController = new AbortController();
    const signal = agentSession.compactionController.signal;
    this.updateKeepAlive();
    broadcastToViewers(sessionId, {
      type: 'session_state',
      sessionId,
      // 带上待投递的用户消息，压缩期间用户气泡保持可见（前端 session_state 全量
      // 替换，不带就会冲掉乐观插入的气泡）。
      messages: [...messages, pendingUserMessage],
      isRunning: true,
      isCompacting: true,
      pendingTools: [],
    });

    try {
      // 解析压缩模型：配置了专用小模型且凭证可用就用它，否则回退主模型（静默）。
      const { model: compactModel, apiKey } = await this.resolveCompactionModel(model);
      // 取消优先：解析期间被 cancel，丢弃压缩并让调用方放弃本轮。
      if (signal.aborted) return await this.commitCompactionCancel(agentSession, pendingUserMessage);
      // 无凭证无法发起独立的摘要请求，本轮裸发、下一轮再尝试压缩（不致 400：
      // transformContext 仍会带上已有的最后一条摘要）。
      if (!apiKey) return false;

      const previousSummary =
        lastSummaryIdx >= 0
          ? (messages[lastSummaryIdx] as CompactionSummaryMessage).summary
          : undefined;
      const messagesToSummarize = messages.slice(baseIdx, cut);

      const summary = await runCompaction({
        messagesToSummarize,
        model: compactModel,
        apiKey,
        previousSummary,
        signal,
        thinkingLevel: agentSession.agent.state.thinkingLevel,
      });

      // 取消：丢弃这次压缩，不插摘要，并通知调用方放弃本轮发送。
      if (signal.aborted) return await this.commitCompactionCancel(agentSession, pendingUserMessage);

      if (summary) {
        // 在切点首条 user 之前插入摘要（不变式：摘要紧贴 user turn-start，
        // 保证 truncateForRetry 与 transformContext 无需特判）。原始消息全保留。
        const updated = [
          ...messages.slice(0, cut),
          createCompactionSummaryMessage(summary, tokens),
          ...messages.slice(cut),
        ];
        agentSession.agent.state.messages = updated;
        if (this.persist(agentSession, updated)) {
          await sessionStore.flush(sessionId);
        }
        broadcastToViewers(sessionId, {
          type: 'session_state',
          sessionId,
          // 同样带上待投递的用户消息，避免摘要插入后到 agent.prompt() 之间
          // 这一帧用户气泡闪掉。agent.prompt() 随后会 append 真实的同内容消息。
          messages: [...updated, pendingUserMessage],
          isRunning: true,
          isCompacting: true,
          pendingTools: [],
        });
      }
      // summary 为 null → 降级：runCompaction 内部已重试一次，这里不插摘要、
      // 照常发送。findCompactionCutPoint 的 turn-start 对齐保证不会 400。
      return false;
    } finally {
      agentSession.compactionController = undefined;
      // 若仍停在 compacting（未被其他路径推进），复位回 idle。
      if (agentSession.phase === 'compacting') {
        agentSession.phase = 'idle';
        this.updateKeepAlive();
      }
    }
  }

  /**
   * 压缩中被取消的收尾。压缩跑在 `agent.prompt()` 之前，本轮用户消息此刻还没进
   * `state.messages`——若直接丢弃，取消后这条消息会凭空消失。这里手动把它连同一条
   * aborted 标记补进 state、持久化并广播，使取消后界面与普通运行中取消一致：
   * 用户气泡保留 + 一行灰斜体「已取消」。
   *
   * 复用 `buildAbortedMarker` 造与 pi-agent-core `handleRunFailure` 同形状的标记，
   * 前端 `stopReason === 'aborted'` 的渲染规则一条通吃。
   *
   * 若会话已被 `destroySession` 移除（它也会 abort 同一个 controller），静默退出，
   * 不持久化/广播，避免复活刚删掉的会话行。
   *
   * @returns 恒为 `true` —— 调用方据此放弃本轮发送。
   */
  private async commitCompactionCancel(
    agentSession: AgentSession,
    pendingUserMessage: AgentMessage,
  ): Promise<true> {
    const { sessionId } = agentSession;
    // destroySession 先 abort 再从 map 移除；命中这里说明是销毁而非用户取消，静默退出。
    if (!this.sessions.has(sessionId)) return true;

    const finalMessages: AgentMessage[] = [
      ...agentSession.agent.state.messages,
      pendingUserMessage,
      this.buildAbortedMarker(agentSession),
    ];
    // 同步内存态，否则下一轮 prompt 会基于缺这两条的旧 state 续写并覆盖 DB。
    agentSession.agent.state.messages = finalMessages;

    if (this.persist(agentSession, finalMessages)) {
      try {
        await sessionStore.flush(sessionId);
      } catch (err) {
        console.warn(`[session-manager] flush on compaction cancel failed for ${sessionId}:`, err);
        // 继续广播——DB 落后可恢复，不该把停止按钮卡在界面上。
      }
    }

    broadcastToViewers(sessionId, {
      type: 'session_state',
      sessionId,
      messages: finalMessages,
      isRunning: false,
      isCompacting: false,
      pendingTools: [],
    });
    return true;
  }

  /**
   * Re-run the last user turn for a session.
   *
   * Drops trailing assistant / toolResult messages after the most recent
   * user message and resumes the agent loop from there. Used by the chat
   * UI's "Retry" button — covers both genuine failures (`stopReason: 'error'`)
   * and successful turns the user is unhappy with.
   *
   * # In-place refresh (no rebuild)
   *
   * The live agent is reused as-is. We truncate, then refresh the mutable
   * `state.messages` / `model` / `thinkingLevel` / `systemPrompt` fields in
   * place to pick up any settings the user changed while idle, then call
   * `continue()`. Tools are kept current by `refreshAllSessionTools` (MCP
   * changes), so they're not touched here. Because the agent is never torn
   * down, a `cancel()` racing this flow always finds a live agent — this is
   * the root-cause fix for the historical "stop button stuck after retry"
   * bug (there is no agent-less window to get stuck in).
   *
   * # Abort handling
   *
   * `prepareController.signal` is checked once, right before `continue()`.
   * If aborted, `commitRetryCancel` appends a synthetic aborted marker to
   * the truncated transcript, writes it back onto the still-live agent,
   * persists, and broadcasts `session_state { isRunning: false }`. No
   * teardown and no map eviction — the agent is reused for the next prompt.
   *
   * No-op if no user message exists in the transcript (defensive throw),
   * or if phase is already non-`idle` (concurrent retry or live run).
   *
   * `turn` 同 prompt：本轮重试携带的模型 / 思考档。带它且与活 agent 当前选择不同
   * 时才换并落库；不带（或相同）时保持活 agent 当前的会话选择不动。
   */
  async retry(
    sessionId: string,
    turn?: TurnSettings,
  ): Promise<void> {
    // Cold-load if needed. If multiple retry() calls land concurrently for
    // a session not yet in the map, they all await the same in-flight
    // createAgent promise via the `creating` map, then race for the
    // synchronous phase check below. JavaScript's microtask semantics
    // guarantee one of them flips phase to 'preparing' before any other
    // awakened microtask reads it — so we don't need a separate mutex.
    const agentSession = await this.getOrCreateAgent(sessionId);

    if (agentSession.phase !== 'idle') {
      // Concurrent retry already in flight (`preparing`) or agent currently
      // streaming (`running`). Silent no-op so the duplicate window doesn't
      // see a misleading toast — the in-flight run's broadcasts reconcile
      // every viewing window to the correct state.
      console.debug('[session-manager] retry: phase not idle, ignored', sessionId, agentSession.phase);
      return;
    }

    // Take the preparing slot synchronously, BEFORE any further await. A
    // concurrent retry that wakes up after our await(s) below will hit the
    // phase guard above and bail.
    agentSession.phase = 'preparing';
    agentSession.prepareController = new AbortController();
    const signal = agentSession.prepareController.signal;
    this.updateKeepAlive();
    let busySnapshot: AgentMessage[] | null = null;

    try {
      const messages = [...agentSession.agent.state.messages];
      const truncated = truncateForRetry(messages);
      if (!truncated) {
        // The UI only shows retry on the latest assistant turn, which by
        // definition has a preceding user message. Throwing surfaces the bug
        // instead of silently no-oping.
        throw new Error('No user message found to retry');
      }
      busySnapshot = truncated;
      broadcastToViewers(sessionId, {
        type: 'session_state',
        sessionId,
        messages: truncated,
        isRunning: true,
        pendingTools: this.getPendingToolSnapshot(agentSession),
      });

      // Persist truncation BEFORE continue. An SW restart mid-run must not
      // resurrect the failed turn from disk. `flush` collapses the
      // throttler's pending timer and writes immediately.
      if (this.persist(agentSession, truncated)) {
        await sessionStore.flush(sessionId);
      }

      // 模型 / 思考档：仅当 retry 携带 turn（用户在重试前切了模型 / 思考）且与活
      // agent 当前选择不同时才换并落库；否则保持不动——没有「空闲时改了
      // 全局」需要补读的场景。Tools 由 `refreshAllSessionTools` 保活（MCP 变更），
      // 此处不动。model 与 thinking 各自可选、分别判断、分别落库。
      const turnKey = turn?.model
        ? `${turn.model.provider}/${turn.model.modelId}`
        : null;
      const modelChanged = turnKey != null && turnKey !== agentSession.modelKey;
      const resolved = modelChanged ? await this.resolveSessionModel(turn!.model) : null;
      if (modelChanged && !resolved) throw new Error('No model selected or model not found');

      // Single abort checkpoint — cancel landed during the DB flush or the
      // async settings load, both BEFORE we mutate the agent. Commit an
      // aborted marker and bail; the live agent is left untouched.
      if (signal.aborted) {
        await this.commitRetryCancel(agentSession, truncated);
        return;
      }

      // Apply the refreshed state onto the live agent. `cancelAll` defensively
      // drops any stale pending interactive request (the UI hides retry while
      // a tool is pending, but a late port message could still arrive).
      agentSession.toolCtx.cancelAll();
      agentSession.permissionBridge.cancel();
      agentSession.agent.state.messages = truncated;
      if (resolved) {
        agentSession.agent.state.model = resolved.model;
        agentSession.modelKey = turnKey!;
      }
      // 思考档：把 turn 携带的原始偏好对（可能刚换的）当前模型夹成 effective 档，只有
      // effective 变了才更新 + 落库——覆盖「只换模型、现档不被新模型支持」的情形，并避免
      // 原始档 vs 夹后档的每轮空写
      const nextThinking = turn?.thinkingLevel != null
        ? clampThinkingLevel(agentSession.agent.state.model, turn.thinkingLevel)
        : null;
      const thinkingChanged = nextThinking != null && nextThinking !== agentSession.agent.state.thinkingLevel;
      if (thinkingChanged) {
        agentSession.agent.state.thinkingLevel = nextThinking!;
      }
      // 落库到会话行——会话行是真相来源。只写变了的字段。
      if (agentSession.sessionCreated && (modelChanged || thinkingChanged)) {
        await sessionStore.updateSettings(sessionId, {
          provider: modelChanged ? turn!.model!.provider : undefined,
          model: modelChanged ? turn!.model!.modelId : undefined,
          thinkingLevel: thinkingChanged ? agentSession.agent.state.thinkingLevel : undefined,
        });
      }

      // Re-broadcast busy. `continue()` is invoked on the very next line and
      // fires `agent_start` on entry, so the agent IS effectively running.
      // Broadcasting `false` here would flicker the composer back on.
      broadcastToViewers(sessionId, {
        type: 'session_state',
        sessionId,
        messages: truncated,
        isRunning: true,
        pendingTools: this.getPendingToolSnapshot(agentSession),
      });

      // Resume the agent loop against the truncated transcript (last message
      // is user). Fires `agent_start` which flips phase to 'running';
      // subsequent `agent_end` flips it back to 'idle'.
      await agentSession.agent.continue();
    } catch (err) {
      // In-place refresh never tears down the agent, so the `AgentSession` entry
      // stays consistent — there is no half-built zombie to evict (contrast
      // the old rebuild path, which had to delete the entry on failure).
      //
      // But if we threw AFTER pre-persisting the truncated transcript yet
      // BEFORE mutating the agent (e.g. `resolveSessionModel` rejected), the live
      // agent still holds the OLD full transcript while DB holds the truncated
      // one. Align in-memory state to the truncated snapshot so the next prompt
      // doesn't resurrect the messages retry just dropped, then unblock the UI.
      // Guarded on `phase === 'preparing'`: once `continue()` has fired
      // `agent_start` (phase `running`), the `agent_end` path owns state +
      // broadcast and we must not clobber a marker it may have appended.
      if (busySnapshot && agentSession.phase === 'preparing') {
        agentSession.agent.state.messages = busySnapshot;
        broadcastToViewers(agentSession.sessionId, {
          type: 'session_state',
          sessionId: agentSession.sessionId,
          messages: busySnapshot,
          isRunning: false,
          pendingTools: [],
        });
      }
      throw err;
    } finally {
      agentSession.prepareController = undefined;
      // If the success path ran, agent_start already flipped phase to
      // 'running' (and agent_end will later flip to 'idle'). If we threw, or
      // bailed via `commitRetryCancel` on abort, phase is still 'preparing' —
      // reset it to 'idle' so the next retry can proceed. The agent is never
      // torn down, so the `AgentSession` entry is always live here.
      if (agentSession.phase === 'preparing') {
        agentSession.phase = 'idle';
        this.updateKeepAlive();
      }
    }
  }

  /**
   * Commit a retry that was cancelled during its `preparing` window (before
   * `continue()` started). Appends a synthetic aborted marker to the
   * truncated transcript, writes it back onto the still-live agent, persists,
   * and broadcasts so the UI shows the cancel indicator and re-enables the
   * composer.
   *
   * Unlike the old rebuild-abort path, this neither disposes the agent nor
   * evicts the entry: the in-place agent is reused as-is for the next prompt
   * (which appends a fresh user message, so an assistant-aborted tail is
   * fine). Mirrors `commitCompactionCancel`'s shape so all three cancel paths
   * (running / compaction / retry-preparing) leave the same kind of end-state
   * and the UI needs only one rendering rule for "this turn was cancelled".
   */
  private async commitRetryCancel(
    agentSession: AgentSession,
    truncated: AgentMessage[],
  ): Promise<void> {
    // destroySession aborts `prepareController` then removes the entry; if we
    // reached here because of that (not a user cancel), bail without
    // persist/broadcast so we don't resurrect a just-deleted session row.
    // Mirrors `commitCompactionCancel`'s guard.
    if (!this.sessions.has(agentSession.sessionId)) return;

    const finalMessages: AgentMessage[] = [
      ...truncated,
      this.buildAbortedMarker(agentSession),
    ];
    agentSession.agent.state.messages = finalMessages;
    if (this.persist(agentSession, finalMessages)) {
      try {
        await sessionStore.flush(agentSession.sessionId);
      } catch (err) {
        console.warn(
          `[session-manager] flush on retry cancel failed for ${agentSession.sessionId}:`,
          err,
        );
      }
    }
    broadcastToViewers(agentSession.sessionId, {
      type: 'session_state',
      sessionId: agentSession.sessionId,
      messages: finalMessages,
      isRunning: false,
      pendingTools: [],
    });
  }

  /**
   * Construct a synthetic `stopReason: 'aborted'` assistant message that
   * mirrors the shape pi-agent-core produces inside `handleRunFailure` when
   * a streaming agent is aborted. Used by `commitRetryCancel` (and
   * `commitCompactionCancel`) so cancelling during the `preparing` /
   * `compacting` window leaves the same kind of marker the running path
   * leaves naturally.
   *
   * Pulls model identity (api / provider / id) off the agent's current
   * state — readable on both the still-wired old agent and the
   * just-installed new agent without needing async model resolution.
   * `usage` is zeroed since no tokens were spent.
   */
  private buildAbortedMarker(agentSession: AgentSession): AssistantMessage {
    const model = agentSession.agent.state.model;
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
   * - `preparing`: a `retry()` is mid-preparation. Abort its
   *   `prepareController` so the single signal checkpoint exits via
   *   `commitRetryCancel`, AND call `agent.abort()` defensively in case
   *   `continue()` has already been kicked off (the window after the
   *   checkpoint but before `agent_start` fires). `agent.abort()` is
   *   idempotent — on a dormant or already-dead agent it's a no-op; on an
   *   in-flight agent it stops the loop and `agent_end` broadcasts naturally
   *   through the handler.
   *
   *   We deliberately do NOT touch `sessions`, dispose, or broadcast here:
   *   `retry()`'s own flow (either `commitRetryCancel` for the
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
   * No-op if no `AgentSession` entry exists — the session has nothing to cancel
   * (either never started or already cleaned up).
   *
   * Flushes the throttled session writer BEFORE removing the agent from
   * the map so any concurrent `subscribe` / `prompt` for the same id
   * either reuses the still-live in-memory state or reads a fully-persisted
   * DB row — never an interleaved half-flushed snapshot.
   */
  async cancel(sessionId: string): Promise<void> {
    const agentSession = this.sessions.get(sessionId);
    if (!agentSession) return;

    if (agentSession.phase === 'preparing') {
      // Signal the preparation to bail at its checkpoint, AND stop the agent
      // if it has already entered `continue()`. Cleanup and broadcast are
      // retry()'s responsibility — see method JSDoc.
      agentSession.prepareController?.abort();
      agentSession.agent.abort();
      return;
    }

    if (agentSession.phase === 'compacting') {
      // A pre-turn compaction is running. Abort the in-flight
      // `generateSummary`; `maybeCompact()` detects the abort and routes to
      // `commitCompactionCancel()`, which commits the pending user message +
      // an aborted marker, persists, broadcasts `isRunning: false`, and
      // returns `true` so `prompt()` abandons the turn. No agent run exists
      // yet, so there's nothing to `agent.abort()`. Cleanup and broadcast are
      // the owning method's responsibility — mirrors the `preparing` split
      // where cancel only signals.
      agentSession.compactionController?.abort();
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
    const preLen = agentSession.agent.state.messages.length;
    agentSession.agent.abort();
    agentSession.unsubscribeAgent();
    agentSession.toolCtx.dispose();
    // 显式取消在途授权请求。abort() 的 signal 通常已让 bridge.request 解析，
    // 这里再 cancel 一次是幂等的兜底（bridge 内部有 pendingResolve 守卫）。
    agentSession.permissionBridge.cancel();
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
    await agentSession.agent.waitForIdle();
    // Drain any throttler write scheduled by trailing message_end events
    // from the just-aborted run.
    try {
      await sessionStore.flush(sessionId);
    } catch (err) {
      console.warn(`[session-manager] flush on cancel failed for ${sessionId}:`, err);
    }
    // Snapshot post-abort state. If pi-agent-core appended the marker,
    // length increased by one; if not (idle branch / no active run),
    // length is unchanged and we skip the redundant write.
    const finalMessages = [...agentSession.agent.state.messages];
    if (finalMessages.length !== preLen && this.persist(agentSession, finalMessages)) {
      try {
        await sessionStore.flush(sessionId);
      } catch (err) {
        console.warn(`[session-manager] post-abort persist failed for ${sessionId}:`, err);
        // Continue to broadcast anyway — DB lag is recoverable.
      }
    }
    this.sessions.delete(sessionId);
    this.updateKeepAlive();
    // Ensure client knows the agent stopped (abort may not fire agent_end)
    broadcastToViewers(sessionId, {
      type: 'agent_end',
      sessionId,
      messages: finalMessages,
    });
  }

  /** Resolve an interactive tool's pending request */
  resolveTool(sessionId: string, toolName: string, response: any): void {
    const agentSession = this.sessions.get(sessionId);
    // ctx subscription handles broadcasting tool_resolved
    agentSession?.toolCtx.resolve(toolName, response);
  }

  /** Cancel a specific interactive tool */
  cancelTool(sessionId: string, toolName: string): void {
    const agentSession = this.sessions.get(sessionId);
    // ctx subscription handles broadcasting tool_resolved
    agentSession?.toolCtx.cancel(toolName);
  }

  /**
   * Resolve a tool's pending pre-execution permission prompt with the user's
   * explicit choice. `toolCallId` must match the in-flight request (a stale
   * click on an already-resolved / superseded prompt is ignored). The
   * write-back of the decision onto the permissionRequest message and the
   * broadcast happen inside `requestPermissionDecision`, which is awaiting
   * this bridge.
   */
  resolvePermission(
    sessionId: string,
    toolCallId: string,
    decision: 'once' | 'always' | 'denied',
  ): void {
    const agentSession = this.sessions.get(sessionId);
    if (!agentSession) return;
    const pending = agentSession.permissionBridge.getPending();
    if (!pending || pending.toolCallId !== toolCallId) return; // stale / mismatched
    agentSession.permissionBridge.resolve(decision);
  }

  /** Get current state for a session (for reconnecting clients).
   *
   *  `isRunning` is the sidepanel's "busy" signal: true while the session
   *  cannot accept a normal prompt yet. That includes active streaming, a
   *  retry's `preparing` window, and the `compacting` window, so a
   *  reconnecting or second window keeps the composer blocked instead of
   *  dispatching a prompt the manager would ignore while `phase !== 'idle'`. */
  getSessionState(sessionId: string): {
    messages: AgentMessage[];
    isRunning: boolean;
    isCompacting: boolean;
    pendingTools: { toolName: string; toolCallId: string; args: any }[];
    pendingPermissions: PermissionRequest[];
  } | null {
    const agentSession = this.sessions.get(sessionId);
    if (!agentSession) return null;
    return {
      messages: [...agentSession.agent.state.messages],
      isRunning: agentSession.phase !== 'idle',
      isCompacting: agentSession.phase === 'compacting',
      pendingTools: this.getPendingToolSnapshot(agentSession),
      pendingPermissions: this.getPendingPermissions(agentSession),
    };
  }

  /** Destroy an `AgentSession` entirely */
  destroySession(sessionId: string): void {
    const agentSession = this.sessions.get(sessionId);
    if (agentSession) {
      // Abort in-flight async tails so they can't resurrect a just-deleted
      // session row. Both the compaction path (`maybeCompact` →
      // `commitCompactionCancel`) and the retry preparing path (`retry` →
      // `commitRetryCancel`) check their controller's `signal.aborted` after
      // each await and bail via an entry-presence guard before persisting or
      // broadcasting.
      agentSession.compactionController?.abort();
      agentSession.prepareController?.abort();
      agentSession.unsubscribeAgent();
      agentSession.toolCtx.dispose();
      agentSession.permissionBridge.cancel();
      agentSession.agent.abort();
      this.sessions.delete(sessionId);
      this.updateKeepAlive();
    }
  }
}

export const sessionManager = new SessionManager();

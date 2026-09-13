// Hook: connects sidepanel to the background session manager via chrome.runtime Port.
// Replaces useAgentLifecycle + useSessionManager.

import { useState, useRef, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import {
  CLIENT_PORT,
  type BranchEntryInfo,
  type BroadcastMessage,
  type ClientMessage,
  type ServerMessage,
  type SessionSnapshot,
  type TurnSettings,
} from '@/lib/ipc/protocol';
import type { Attachment } from '@/lib/agent/attachments';
import { buildSlashPromptBlock, type SlashPrompt } from '@/lib/ai-config/slash-prompt';
import { wrapUserRequest } from '@/lib/agent/prompt-envelope';
import { applyStreamOps } from '@/lib/agent/stream-replica';
import type { PermissionRequest } from '@/lib/agent/tool-permissions';
import { replaceUserText, truncateForRetry } from '@/lib/agent/message-helpers';
import type { Message } from '@earendil-works/pi-ai';
import { t } from '@/lib/i18n';
import { recorderChannel } from '@/lib/recorder/sidepanel-channel';
import { mcpAppResourceChannel } from '@/lib/mcp/sidepanel-channel';
import { sessionListChannel } from '@/lib/agent/session-list-channel';
import { myInstanceId } from '@/lib/ipc/instance-id';

// ─── State ───

export interface AgentPortState {
  /** 广播形态：消息 + 可选的树 entryId（消息编辑用它定位；乐观 / 流式消息没有）。 */
  messages: BroadcastMessage[];
  /** 当前分支的分支点信息（稀疏，键为 entryId）。只在结构可能变化的帧下发，
   *  缺省帧保持上一次的值。 */
  branchInfo: Record<string, BranchEntryInfo>;
  isAgentRunning: boolean;
  /** 后台正在执行发送前的上下文压缩时为 true。用于驱动一个与普通思考态不同的
   *  「压缩中」指示。 */
  isCompacting: boolean;
  sessionId: string | null;
  sessionTitle: string;
  connected: boolean;
  /** Last error message from the agent, cleared on next prompt. */
  lastError: string | null;
}

// ─── Pending interactive tool info (for UI rendering) ───

export interface PendingToolInfo {
  toolCallId: string;
  args: any;
}

// 权限提示卡片的请求形状（PermissionRequest）来自 @/lib/agent/tool-permissions，
// UI 需要时直接从那里 import；本 hook 仅在内部按 toolCallId 维护活 pending。

export type PromptDispatchResult =
  | { status: 'dispatched' }
  | { status: 'notDispatched'; reason: 'empty' | 'unavailable' };

const PROMPT_RECONNECT_TIMEOUT_MS = 1_500;

// ─── Callbacks ───

export interface AgentPortCallbacks {
  onSessionCreated?: (sessionId: string, title: string) => void;
  onSessionLoaded?: (session: SessionSnapshot | null) => void;
  /** 重新订阅一个仍有活 agent 的会话时，后台走 `session_state`（带消息但非完整
   *  会话行）。这里把该会话的 provider / model / 思考档单独回传，供上层回填本地的
   *  turn 草稿——与 `onSessionLoaded` 对齐，修复「发消息后进设置再返回模型被重置」。 */
  onSessionSettings?: (provider: string, model: string, thinkingLevel: string) => void;
  /** `session_fork` 成功（issue #60）：`sessionId` 是**新**会话。上层据此跳转；hook 本身
   *  不切换 `state.sessionId`——新会话内容在后台，由路由变化触发的普通 subscribe 拉取。 */
  onSessionForked?: (sessionId: string, title: string) => void;
}

// ─── Hook ───

export function useBackgroundAgent(callbacks: AgentPortCallbacks) {
  const [state, setState] = useState<AgentPortState>({
    messages: [],
    branchInfo: {},
    isAgentRunning: false,
    isCompacting: false,
    sessionId: null,
    sessionTitle: '',
    connected: false,
    lastError: null,
  });

  const [pendingTools, setPendingTools] = useState<Map<string, PendingToolInfo>>(new Map());

  // Live permission prompts keyed by toolCallId. Drives the answerable-vs-expired
  // distinction for permissionRequest cards: a card whose toolCallId is absent
  // here has no live agent awaiting it.
  const [pendingPermissions, setPendingPermissions] = useState<Map<string, PermissionRequest>>(new Map());

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // 分叉在途标记（issue #60）：分叉要复制树路径与整个工作区、不是瞬时的，而按钮没有
  // 乐观隐藏，双击会建出两个副本。回包（成功 / 失败）或端口断开时清掉。
  const forkPendingRef = useRef(false);
  // 本次 subscribe 之后收到的当前会话改名。冷加载快照（session_loaded / 首帧 session_state）
  // 是后台在收到 subscribe 时读的行，若别的窗口在这之后改了名，广播先到、快照后到，快照里的
  // 旧标题会把新名盖回去——快照到达时若已有更新的改名，以改名为准。
  const renamedSinceSubscribeRef = useRef<{ sessionId: string; title: string } | null>(null);
  const connectedWaitersRef = useRef<Set<(connected: boolean) => void>>(new Set());
  const scheduleRetryRef = useRef<(() => void) | null>(null);
  // 流式副本漂移时的重同步：重发 subscribe 拉权威快照（session_state）。
  // 幂等 + 1s 时间去重——它可能从 setState updater 里被调用（含 StrictMode
  // 双调用），重复触发的代价只是一帧多余的快照。
  const lastResyncAtRef = useRef(0);
  const requestResyncRef = useRef<((sessionId: string) => void) | null>(null);
  requestResyncRef.current = (sessionId: string) => {
    // updater 可能延迟到会话已切换后才执行——重发过期会话的 subscribe 会把
    // background 的 viewer 路由改回旧会话，新会话从此收不到广播。只为当前
    // 会话重同步
    if (sessionIdRef.current !== sessionId) return;
    const now = Date.now();
    if (now - lastResyncAtRef.current < 1_000) return;
    lastResyncAtRef.current = now;
    portRef.current?.postMessage({ type: 'subscribe', sessionId } satisfies ClientMessage);
  };
  // Stable callback refs to avoid re-creating the port listener
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  // Connect to background on mount, with auto-reconnect on disconnect.
  useEffect(() => {
    let unmounted = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    const MAX_RETRY_DELAY = 30_000;
    const BASE_DELAY = 500;

    const handleMessage = (msg: ServerMessage) => {
      if (unmounted) return;
      const isCurrentSession = (sessionId: string | null | undefined) =>
        sessionId != null && sessionId === sessionIdRef.current;
      switch (msg.type) {
        case 'connected': {
          retryCount = 0;
          // 新端口上不可能收到旧端口的分叉回包：无论旧端口是怎么失效的（onDisconnect
          // 或发送抛错后被置空），都在这里复位在途标记，避免分叉被永久拒绝。
          forkPendingRef.current = false;
          setState(prev => ({ ...prev, connected: true, lastError: null }));
          const waiters = Array.from(connectedWaitersRef.current);
          connectedWaitersRef.current.clear();
          for (const resolve of waiters) resolve(true);
          break;
        }

        case 'session_state':
          if (!isCurrentSession(msg.sessionId)) break;
          if (msg.pendingTools) {
            const next = new Map<string, PendingToolInfo>();
            for (const pending of msg.pendingTools) {
              next.set(pending.toolName, {
                toolCallId: pending.toolCallId,
                args: pending.args,
              });
            }
            setPendingTools(next);
          }
          if (msg.pendingPermissions) {
            const nextPerms = new Map<string, PermissionRequest>();
            for (const req of msg.pendingPermissions) {
              nextPerms.set(req.toolCallId, req);
            }
            setPendingPermissions(nextPerms);
          }
          setState(prev => ({
            ...prev,
            sessionId: msg.sessionId,
            // Title is only included on initial subscribe (loaded from DB);
            // mid-stream rebuild broadcasts omit it, so preserve the existing
            // value rather than wiping the header.
            ...(msg.title !== undefined
              ? {
                  sessionTitle: renamedSinceSubscribeRef.current?.sessionId === msg.sessionId
                    ? renamedSinceSubscribeRef.current.title
                    : msg.title,
                }
              : {}),
            messages: msg.messages,
            // 分支信息只在结构可能变化的帧携带；缺省帧保持现值，避免切换器闪没
            branchInfo: msg.branchInfo ?? prev.branchInfo,
            isAgentRunning: msg.isRunning,
            isCompacting: msg.isCompacting ?? false,
          }));
          // 模型字段同样仅首次订阅携带（mid-stream rebuild 省略），用以回填 turn 草稿。
          if (msg.provider !== undefined) {
            callbacksRef.current.onSessionSettings?.(msg.provider, msg.model ?? '', msg.thinkingLevel ?? '');
          }
          break;

        case 'agent_start':
          if (!isCurrentSession(msg.sessionId)) break;
          setState(prev => ({ ...prev, isAgentRunning: true, isCompacting: false }));
          break;

        case 'stream_ops':
          if (!isCurrentSession(msg.sessionId)) break;
          setState(prev => {
            const next = applyStreamOps(prev.messages, msg.ops);
            if (next === null) {
              // 副本漂移（正常流程不该发生）：保持现状，请求重新订阅拉取
              // 权威快照。副本在 message_end / agent_end 的全量 transcript
              // 边界也会被整体校正，这里只是提前自愈。
              // 在 updater 里发起副作用不理想，但 requestResync 幂等且带
              // 时间去重（StrictMode 双调用也只发一次），坏处有界。
              requestResyncRef.current?.(msg.sessionId);
              return prev;
            }
            return { ...prev, messages: next };
          });
          break;

        case 'message_end':
          if (!isCurrentSession(msg.sessionId)) break;
          setState(prev => ({ ...prev, messages: msg.messages }));
          break;

        case 'agent_end':
          if (!isCurrentSession(msg.sessionId)) break;
          setState(prev => ({
            ...prev,
            messages: msg.messages,
            branchInfo: msg.branchInfo ?? prev.branchInfo,
            isAgentRunning: false,
            isCompacting: false,
          }));
          setPendingTools(new Map());
          setPendingPermissions(new Map());
          break;

        case 'tool_pending':
          if (!isCurrentSession(msg.sessionId)) break;
          setPendingTools(prev => {
            const next = new Map(prev);
            next.set(msg.toolName, { toolCallId: msg.toolCallId, args: msg.args });
            return next;
          });
          break;

        case 'tool_resolved':
          if (!isCurrentSession(msg.sessionId)) break;
          setPendingTools(prev => {
            const next = new Map(prev);
            next.delete(msg.toolName);
            return next;
          });
          break;

        case 'session_created':
          if (!isCurrentSession(msg.sessionId)) break;
          setPendingTools(new Map());
          setPendingPermissions(new Map());
          setState(prev => ({
            ...prev,
            sessionId: msg.sessionId,
            sessionTitle: msg.title,
          }));
          callbacksRef.current.onSessionCreated?.(msg.sessionId, msg.title);
          break;

        case 'session_forked':
          forkPendingRef.current = false;
          callbacksRef.current.onSessionForked?.(msg.sessionId, msg.title);
          break;

        case 'session_fork_failed':
          forkPendingRef.current = false;
          // 不写 lastError：那条会被渲染成「本轮对话出错」的错误条并清掉运行态，而分叉
          // 失败与正在进行的对话无关，toast 一下即可。
          console.warn('[AgentPort] session_fork failed:', msg.error);
          toast.error(t('chat.session.forkFailed'));
          break;

        case 'session_loaded':
          if (!isCurrentSession(msg.sessionId)) break;
          setPendingTools(new Map());
          setPendingPermissions(new Map());
          if (msg.session) {
            setState(prev => ({
              ...prev,
              sessionId: msg.session!.id,
              sessionTitle: renamedSinceSubscribeRef.current?.sessionId === msg.session!.id
                ? renamedSinceSubscribeRef.current.title
                : msg.session!.title,
              messages: msg.session!.messages,
              branchInfo: msg.session!.branchInfo ?? {},
              isAgentRunning: false,
              isCompacting: false,
            }));
          }
          callbacksRef.current.onSessionLoaded?.(msg.session);
          break;

        case 'session_list_result':
          sessionListChannel.publishList(msg.sessions);
          break;

        case 'session_deleted':
          sessionListChannel.publishDeleted(msg.sessionIds);
          break;

        case 'session_write_failed':
          // 改名的失败提示放在这条常驻路径上：页头改名时历史面板通常关着，channel 那头
          // 没有订阅者。useSessionList 对 rename 只做列表刷新、不再 toast，避免重复。
          if (msg.op === 'rename') toast.error(t('common.session.renameFailed'));
          sessionListChannel.publishWriteFailed(msg.op, msg.sessionIds, msg.error);
          break;

        case 'session_placement_changed':
          sessionListChannel.publishPlacement(msg.sessionIds, msg.placement);
          break;

        case 'session_renamed':
          // 当前会话被改名（本窗口或别的窗口）：更新页头；同时转给历史面板同步列表项。
          if (isCurrentSession(msg.sessionId)) {
            renamedSinceSubscribeRef.current = { sessionId: msg.sessionId, title: msg.title };
            setState(prev => ({ ...prev, sessionTitle: msg.title }));
          }
          sessionListChannel.publishRenamed(msg.sessionId, msg.title);
          break;

        case 'session_list_error':
          sessionListChannel.publishError(msg.error);
          break;

        case 'error':
          if (msg.sessionId && !isCurrentSession(msg.sessionId)) break;
          console.error('[AgentPort] Error:', msg.error);
          setState(prev => ({ ...prev, isAgentRunning: false, isCompacting: false, lastError: msg.error }));
          break;

        case 'recorder_status':
          recorderChannel.publishStatus({
            isRecording: msg.isRecording,
            startedAt: msg.startedAt,
            eventCount: msg.eventCount,
            truncated: msg.truncated,
            initiatorInstanceId: msg.initiatorInstanceId,
            activeWindowId: msg.activeWindowId,
          });
          break;

        case 'recorder_session':
          recorderChannel.publishSession(msg.session);
          break;

        case 'recorder_start_rejected':
          recorderChannel.publishRejection({ reason: msg.reason });
          break;

        case 'mcp_resource_result':
          mcpAppResourceChannel.handleResult(msg);
          break;
      }
    };

    function scheduleRetry() {
      if (unmounted) return;
      const delay = Math.min(BASE_DELAY * 2 ** retryCount, MAX_RETRY_DELAY);
      retryCount++;
      if (retryCount === 5) {
        setState(prev => ({
          ...prev,
          lastError: t('chat.session.reconnecting'),
        }));
      }
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay);
    }

    scheduleRetryRef.current = scheduleRetry;

    function connect() {
      if (unmounted) return;
      const sessionToRestore = sessionIdRef.current;

      let port: chrome.runtime.Port;
      try {
        port = chrome.runtime.connect({ name: CLIENT_PORT });
      } catch {
        scheduleRetry();
        return;
      }
      portRef.current = port;
      // Expose to the recorder channel so useRecorder can post start/stop.
      recorderChannel.setPort(port);
      // Expose to the MCP App resource channel so useMCPAppResource can
      // fetch `ui://` HTML for inline iframe rendering.
      mcpAppResourceChannel.setPort(port);

      port.onMessage.addListener(handleMessage);

      let disconnected = false;
      const handleDisconnect = () => {
        if (unmounted) return;
        if (disconnected) return;
        disconnected = true;
        if (portRef.current === port) {
          portRef.current = null;
          recorderChannel.setPort(null);
          mcpAppResourceChannel.setPort(null);
          sessionListChannel.setPort(null);
          // 在途分叉的回包随端口一起丢了，别让标记把后续分叉永久卡死。
          forkPendingRef.current = false;
          setState(prev => ({ ...prev, connected: false }));
        }
        scheduleRetry();
      };
      port.onDisconnect.addListener(handleDisconnect);

      // Tell the background which sidepanel/tab instance this port belongs
      // to so the recorder can gate stop() and detect initiator-disconnect.
      // Sent synchronously — the instance id is generated at module load
      // and doesn't require an async Chrome API — so the BG sees the hello
      // before any other message we might post on this port.
      try {
        port.postMessage({
          type: 'hello',
          instanceId: myInstanceId,
        } satisfies ClientMessage);
        if (sessionToRestore) {
          port.postMessage({ type: 'subscribe', sessionId: sessionToRestore } satisfies ClientMessage);
        }
        // 会话列表通道：交出端口后 HistoryPanel 才能拉列表 / 删除，不必自己开端口。
        // 必须放在 hello 之后——它是三个 channel 里唯一会在 setPort 时同步发消息的
        // （断线重连且面板正开着时会补拉一次列表），先挂上就会抢在 hello 前面。
        sessionListChannel.setPort(port);
      } catch {
        handleDisconnect();
      }
    }

    connect();

    return () => {
      unmounted = true;
      if (retryTimer) clearTimeout(retryTimer);
      scheduleRetryRef.current = null;
      const waiters = Array.from(connectedWaitersRef.current);
      connectedWaitersRef.current.clear();
      for (const resolve of waiters) resolve(false);
      portRef.current?.disconnect();
      portRef.current = null;
      recorderChannel.setPort(null);
      mcpAppResourceChannel.setPort(null);
      sessionListChannel.setPort(null);
    };
  }, []);

  // ─── Actions ───

  const postMessage = useCallback((msg: ClientMessage) => {
    portRef.current?.postMessage(msg);
  }, []);

  const waitForConnected = useCallback((timeoutMs: number): Promise<boolean> => {
    if (portRef.current) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (connected: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        connectedWaitersRef.current.delete(finish);
        resolve(connected && !!portRef.current);
      };
      const timeout = setTimeout(() => finish(false), timeoutMs);
      connectedWaitersRef.current.add(finish);
    });
  }, []);

  const dispatchPrompt = useCallback((
    text: string,
    attachments: Attachment[] | undefined,
    expectedSessionId: string | null,
    turn?: TurnSettings,
    slashPrompt?: SlashPrompt,
  ): boolean => {
    if (sessionIdRef.current !== expectedSessionId) return false;

    const port = portRef.current;
    if (!port) return false;

    const existingSessionId = sessionIdRef.current;
    const sessionId = existingSessionId ?? crypto.randomUUID();

    try {
      port.postMessage({ type: 'prompt', sessionId, text, attachments, slashPrompt, model: turn?.model, thinkingLevel: turn?.thinkingLevel });
    } catch {
      if (portRef.current === port) {
        portRef.current = null;
        recorderChannel.setPort(null);
        mcpAppResourceChannel.setPort(null);
        sessionListChannel.setPort(null);
        setState(prev => ({ ...prev, connected: false }));
        scheduleRetryRef.current?.();
      }
      return false;
    }

    // 真正投递成功后再写入新 sessionId，避免重连等待期间订阅一个尚未创建的会话。
    if (!existingSessionId) {
      sessionIdRef.current = sessionId;
    }

    // Optimistically add user message to local state for immediate UI feedback
    setState(prev => {
      // 乐观消息按后台那套信封的形状拼，与广播回来的真消息逐字节同形——两者解析结果
      // 一致，切换时不会跳变。
      //
      // 请求块**无条件**包：不包的话这条消息是「裸文本」，用户自己打的字里若出现字面量
      // `<user-request>`，乐观态与广播态会解析出不同的结果。提示词块则在带了提示词时才包，
      // 否则只挂了提示词、没打字的那一轮会渲染成彻底空白（连气泡都没有），像消息发丢了。
      const request = wrapUserRequest(text.trim());
      const optimisticText = slashPrompt
        ? `${buildSlashPromptBlock(slashPrompt)}\n\n${request}`
        : request;
      const content: any[] = [{ type: 'text' as const, text: optimisticText }];
      // Include image attachments in optimistic message for preview
      if (attachments) {
        for (const att of attachments) {
          if (att.type === 'image') {
            content.push({ type: 'image', data: att.data, mimeType: att.mimeType });
          }
        }
      }
      const userMsg = { role: 'user' as const, content, timestamp: Date.now() };
      return {
        ...prev,
        messages: [...prev.messages, userMsg as any],
        isAgentRunning: true,
        isCompacting: false,
        lastError: null,
      };
    });
    return true;
  }, []);

  const send = useCallback(async (
    text: string,
    attachments?: Attachment[],
    expectedSessionId: string | null = sessionIdRef.current,
    turn?: TurnSettings,
    slashPrompt?: SlashPrompt,
  ): Promise<PromptDispatchResult> => {
    const trimmed = text.trim();
    // 挂了斜杠提示词时空文本也算有内容——提示词本身就是这一轮的请求（issue #53）。
    if (!trimmed && !slashPrompt) return { status: 'notDispatched', reason: 'empty' };

    const startedSessionId = expectedSessionId;
    if (dispatchPrompt(trimmed, attachments, startedSessionId, turn, slashPrompt)) return { status: 'dispatched' };

    const connected = await waitForConnected(PROMPT_RECONNECT_TIMEOUT_MS);
    if (!connected || sessionIdRef.current !== startedSessionId) {
      if (sessionIdRef.current === startedSessionId) {
        setState(prev => ({ ...prev, lastError: t('chat.session.notConnected') }));
      }
      return { status: 'notDispatched', reason: 'unavailable' };
    }

    if (dispatchPrompt(trimmed, attachments, startedSessionId, turn, slashPrompt)) return { status: 'dispatched' };

    setState(prev => ({ ...prev, lastError: t('chat.session.notConnected') }));
    return { status: 'notDispatched', reason: 'unavailable' };
  }, [dispatchPrompt, waitForConnected]);

  const cancel = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (sessionId) postMessage({ type: 'cancel', sessionId });
  }, [postMessage]);

  /** 编辑一条已发送的 user 消息并从该点重新生成（issue #44）。乐观更新：本地按
   *  entryId 截断到该消息之前、放入换好文案的 user 气泡（复用后台同款
   *  replaceUserText，附件徽标不闪），随后的权威广播完成收敛。 */
  const editMessage = useCallback((entryId: string, text: string, turn?: TurnSettings) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    if (!portRef.current) {
      setState(prev => ({ ...prev, lastError: t('chat.session.notConnected') }));
      return;
    }
    setState(prev => {
      const index = prev.messages.findIndex(m => m.entryId === entryId);
      if (index < 0) return prev;
      // 剥掉旧 entryId：编辑产生的是尚未落树的新消息，保留旧 id 会与后台
      // 广播帧的「未提交消息无 id」约定冲突
      const { entryId: _stale, ...edited } = {
        ...replaceUserText(prev.messages[index] as Message, text),
        timestamp: Date.now(),
      } as BroadcastMessage;
      return {
        ...prev,
        messages: [...prev.messages.slice(0, index), edited],
        isAgentRunning: true,
        isCompacting: false,
        lastError: null,
      };
    });
    postMessage({ type: 'edit_message', sessionId, entryId, text, model: turn?.model, thinkingLevel: turn?.thinkingLevel });
  }, [postMessage]);

  /** 切换到分支点上的另一个兄弟版本。后台 moveLane + 重投影后以 session_state
   *  （带 branchInfo）广播回来，本地不做乐观切换（树在后台，无从预知目标分支内容）。 */
  const switchBranch = useCallback((targetEntryId: string) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    if (!portRef.current) {
      setState(prev => ({ ...prev, lastError: t('chat.session.notConnected') }));
      return;
    }
    postMessage({ type: 'switch_branch', sessionId, targetEntryId });
  }, [postMessage]);

  /** 从当前会话的某条 assistant 消息处分叉出新会话（issue #60）。无乐观状态：新会话
   *  在后台建好后以 `session_forked` 回来，由 onSessionForked 跳转。同一时刻只允许一个
   *  分叉在途（见 forkPendingRef）。 */
  const forkSession = useCallback((entryId: string) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    if (!portRef.current) {
      toast.error(t('chat.session.notConnected'));
      return;
    }
    if (forkPendingRef.current) return;
    forkPendingRef.current = true;
    try {
      postMessage({ type: 'session_fork', sessionId, entryId });
    } catch (err) {
      // 端口已死（SW 重启 / 断连）：这次没发出去，标记必须收回，重连由 onDisconnect 驱动。
      forkPendingRef.current = false;
      console.warn('[AgentPort] session_fork post failed:', err);
      toast.error(t('chat.session.notConnected'));
    }
  }, [postMessage]);

  const retry = useCallback((
    turn?: TurnSettings,
    entryId?: string,
  ) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    if (!portRef.current) {
      setState(prev => ({ ...prev, lastError: t('chat.session.notConnected') }));
      return;
    }
    // Optimistic update: locally apply the SAME truncation the background
    // will perform (drop everything after the last user message) and flip
    // `isAgentRunning` to true. Three effects, all immediate:
    //
    //   1. The errored / unwanted assistant bubble disappears right away —
    //      no waiting for the BG round-trip's `session_state` broadcast,
    //      which used to leave the streaming cursor stranded at the end
    //      of the old bubble for ~100–300ms.
    //   2. Retry button hides instantly so a double-click in this window
    //      can't fire a second IPC.
    //   3. Prior `lastError` clears.
    //
    // Multi-window safety: every subscribed window receives the BG's
    // authoritative `session_state` later; this window's local state
    // converges to that broadcast without flicker because the shared
    // `truncateForRetry` helper guarantees we computed the same array.
    // Defensive bail: if there's somehow no user message to retry from,
    // skip the optimistic step and let the background's own no-op path
    // surface the issue (matches BG's defensive throw).
    setState(prev => {
      // 指定轮重试：截到目标 user 消息（含）；缺省沿用最后一轮语义
      const truncated = entryId
        ? (() => {
            const index = prev.messages.findIndex(m => m.entryId === entryId);
            return index >= 0 ? prev.messages.slice(0, index + 1) : null;
          })()
        : truncateForRetry(prev.messages);
      return {
        ...prev,
        messages: truncated ?? prev.messages,
        isAgentRunning: true,
        isCompacting: false,
        lastError: null,
      };
    });
    postMessage({ type: 'retry', sessionId, entryId, model: turn?.model, thinkingLevel: turn?.thinkingLevel });
  }, [postMessage]);

  const subscribe = useCallback((sessionId: string) => {
    const isSessionChange = sessionIdRef.current !== sessionId;
    if (isSessionChange) {
      setPendingTools(new Map());
      setPendingPermissions(new Map());
    }
    sessionIdRef.current = sessionId;
    renamedSinceSubscribeRef.current = null;
    setState(prev => isSessionChange
      ? {
          ...prev,
          messages: [],
          branchInfo: {},
          isAgentRunning: false,
          isCompacting: false,
          sessionTitle: '',
          lastError: null,
        }
      : { ...prev, sessionId });
    postMessage({ type: 'subscribe', sessionId });
  }, [postMessage]);

  const unsubscribe = useCallback(() => {
    sessionIdRef.current = null;
    setState({
      messages: [],
      branchInfo: {},
      isAgentRunning: false,
      isCompacting: false,
      sessionId: null,
      sessionTitle: '',
      connected: true,
      lastError: null,
    });
    setPendingTools(new Map());
    setPendingPermissions(new Map());
    postMessage({ type: 'unsubscribe' });
  }, [postMessage]);

  const resolveTool = useCallback((toolName: string, response: any) => {
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      postMessage({ type: 'resolve_tool', sessionId, toolName, response });
      setPendingTools(prev => {
        const next = new Map(prev);
        next.delete(toolName);
        return next;
      });
    }
  }, [postMessage]);

  const cancelTool = useCallback((toolName: string) => {
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      postMessage({ type: 'cancel_tool', sessionId, toolName });
      setPendingTools(prev => {
        const next = new Map(prev);
        next.delete(toolName);
        return next;
      });
    }
  }, [postMessage]);

  // Answer a tool's pre-execution permission prompt. We do NOT optimistically
  // clear `pendingPermissions` here: the BG resolves the bridge, writes the
  // decision back onto the permissionRequest message, and re-broadcasts a
  // single `session_state` carrying both the decided message AND an empty
  // pendingPermissions — so the card transitions answerable→decided in one
  // atomic update. Clearing locally first would momentarily leave the message
  // as `pending` with no live entry, which `PermissionRequestBlock` would
  // render as the "expired" state — a misleading flash on a valid click.
  const resolvePermission = useCallback(
    (toolCallId: string, decision: 'once' | 'always' | 'denied') => {
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        postMessage({ type: 'resolve_permission', sessionId, toolCallId, decision });
      }
    },
    [postMessage],
  );

  return {
    state,
    pendingTools,
    pendingPermissions,
    send,
    cancel,
    retry,
    editMessage,
    switchBranch,
    forkSession,
    subscribe,
    unsubscribe,
    resolveTool,
    cancelTool,
    resolvePermission,
  };
}

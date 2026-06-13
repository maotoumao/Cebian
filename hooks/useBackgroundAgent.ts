// Hook: connects sidepanel to background agent manager via chrome.runtime Port.
// Replaces useAgentLifecycle + useSessionManager.

import { useState, useRef, useEffect, useCallback } from 'react';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { AGENT_PORT_NAME, type ClientMessage, type ServerMessage, type SessionMeta } from '@/lib/protocol';
import type { SessionRecord } from '@/lib/db';
import type { Attachment } from '@/lib/attachments';
import type { PermissionRequest } from '@/lib/tool-permissions';
import { truncateForRetry } from '@/lib/message-helpers';
import { t } from '@/lib/i18n';
import { recorderChannel } from '@/lib/recorder/sidepanel-channel';
import { mcpAppResourceChannel } from '@/lib/mcp/sidepanel-channel';
import { myInstanceId } from '@/lib/instance-id';

// ─── State ───

export interface AgentPortState {
  messages: AgentMessage[];
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

// 权限提示卡片的请求形状（PermissionRequest）来自 @/lib/tool-permissions，
// UI 需要时直接从那里 import；本 hook 仅在内部按 toolCallId 维护活 pending。

export type PromptDispatchResult =
  | { status: 'dispatched' }
  | { status: 'notDispatched'; reason: 'empty' | 'unavailable' };

const PROMPT_RECONNECT_TIMEOUT_MS = 1_500;

// ─── Callbacks ───

export interface AgentPortCallbacks {
  onSessionCreated?: (sessionId: string, title: string) => void;
  onSessionLoaded?: (session: SessionRecord | null) => void;
  onSessionList?: (sessions: SessionMeta[]) => void;
  onSessionDeleted?: (sessionId: string) => void;
}

// ─── Hook ───

export function useBackgroundAgent(callbacks: AgentPortCallbacks) {
  const [state, setState] = useState<AgentPortState>({
    messages: [],
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
  const connectedWaitersRef = useRef<Set<(connected: boolean) => void>>(new Set());
  const scheduleRetryRef = useRef<(() => void) | null>(null);
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
            ...(msg.title !== undefined ? { sessionTitle: msg.title } : {}),
            messages: msg.messages,
            isAgentRunning: msg.isRunning,
            isCompacting: msg.isCompacting ?? false,
          }));
          break;

        case 'agent_start':
          if (!isCurrentSession(msg.sessionId)) break;
          setState(prev => ({ ...prev, isAgentRunning: true, isCompacting: false }));
          break;

        case 'message_update':
          if (!isCurrentSession(msg.sessionId)) break;
          setState(prev => {
            const msgs = [...prev.messages];
            const last = msgs[msgs.length - 1];
            if (last && last.role === 'assistant') {
              msgs[msgs.length - 1] = msg.message;
            } else {
              msgs.push(msg.message);
            }
            return { ...prev, messages: msgs };
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

        case 'session_loaded':
          if (!isCurrentSession(msg.sessionId)) break;
          setPendingTools(new Map());
          setPendingPermissions(new Map());
          if (msg.session) {
            setState(prev => ({
              ...prev,
              sessionId: msg.session!.id,
              sessionTitle: msg.session!.title,
              messages: msg.session!.messages,
              isAgentRunning: false,
              isCompacting: false,
            }));
          }
          callbacksRef.current.onSessionLoaded?.(msg.session);
          break;

        case 'session_list_result':
          callbacksRef.current.onSessionList?.(msg.sessions);
          break;

        case 'session_deleted':
          callbacksRef.current.onSessionDeleted?.(msg.sessionId);
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
        port = chrome.runtime.connect({ name: AGENT_PORT_NAME });
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
  ): boolean => {
    if (sessionIdRef.current !== expectedSessionId) return false;

    const port = portRef.current;
    if (!port) return false;

    const existingSessionId = sessionIdRef.current;
    const sessionId = existingSessionId ?? crypto.randomUUID();

    try {
      port.postMessage({ type: 'prompt', sessionId, text, attachments });
    } catch {
      if (portRef.current === port) {
        portRef.current = null;
        recorderChannel.setPort(null);
        mcpAppResourceChannel.setPort(null);
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
      const content: any[] = [{ type: 'text' as const, text: text.trim() }];
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
  ): Promise<PromptDispatchResult> => {
    const trimmed = text.trim();
    if (!trimmed) return { status: 'notDispatched', reason: 'empty' };

    const startedSessionId = expectedSessionId;
    if (dispatchPrompt(trimmed, attachments, startedSessionId)) return { status: 'dispatched' };

    const connected = await waitForConnected(PROMPT_RECONNECT_TIMEOUT_MS);
    if (!connected || sessionIdRef.current !== startedSessionId) {
      if (sessionIdRef.current === startedSessionId) {
        setState(prev => ({ ...prev, lastError: t('chat.session.notConnected') }));
      }
      return { status: 'notDispatched', reason: 'unavailable' };
    }

    if (dispatchPrompt(trimmed, attachments, startedSessionId)) return { status: 'dispatched' };

    setState(prev => ({ ...prev, lastError: t('chat.session.notConnected') }));
    return { status: 'notDispatched', reason: 'unavailable' };
  }, [dispatchPrompt, waitForConnected]);

  const cancel = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (sessionId) postMessage({ type: 'cancel', sessionId });
  }, [postMessage]);

  const retry = useCallback(() => {
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
      const truncated = truncateForRetry(prev.messages);
      return {
        ...prev,
        messages: truncated ?? prev.messages,
        isAgentRunning: true,
        isCompacting: false,
        lastError: null,
      };
    });
    postMessage({ type: 'retry', sessionId });
  }, [postMessage]);

  const subscribe = useCallback((sessionId: string) => {
    const isSessionChange = sessionIdRef.current !== sessionId;
    if (isSessionChange) {
      setPendingTools(new Map());
      setPendingPermissions(new Map());
    }
    sessionIdRef.current = sessionId;
    setState(prev => isSessionChange
      ? {
          ...prev,
          messages: [],
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

  const listSessions = useCallback(() => {
    postMessage({ type: 'session_list' });
  }, [postMessage]);

  const deleteSession = useCallback((sessionId: string) => {
    postMessage({ type: 'session_delete', sessionId });
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
    subscribe,
    unsubscribe,
    listSessions,
    deleteSession,
    resolveTool,
    cancelTool,
    resolvePermission,
  };
}

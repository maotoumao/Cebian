// Hook: connects sidepanel to background agent manager via chrome.runtime Port.
// Replaces useAgentLifecycle + useSessionManager.

import { useState, useRef, useEffect, useCallback } from 'react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { AGENT_PORT_NAME, type ClientMessage, type ServerMessage, type SessionMeta } from '@/lib/protocol';
import type { SessionRecord } from '@/lib/db';
import type { Attachment } from '@/lib/attachments';

// ─── State ───

export interface AgentPortState {
  messages: AgentMessage[];
  isAgentRunning: boolean;
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
    sessionId: null,
    sessionTitle: '',
    connected: false,
    lastError: null,
  });

  const [pendingTools, setPendingTools] = useState<Map<string, PendingToolInfo>>(new Map());

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const sessionIdRef = useRef<string | null>(null);
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
      switch (msg.type) {
        case 'connected':
          retryCount = 0;
          setState(prev => ({ ...prev, connected: true, lastError: null }));
          break;

        case 'session_state':
          sessionIdRef.current = msg.sessionId;
          setState(prev => ({
            ...prev,
            sessionId: msg.sessionId,
            messages: msg.messages,
            isAgentRunning: msg.isRunning,
          }));
          break;

        case 'agent_start':
          setState(prev => ({ ...prev, isAgentRunning: true }));
          break;

        case 'message_update':
          setState(prev => {
            const msgs = [...prev.messages];
            const last = msgs[msgs.length - 1];
            if (last && 'role' in last && last.role === 'assistant') {
              msgs[msgs.length - 1] = msg.message;
            } else {
              msgs.push(msg.message);
            }
            return { ...prev, messages: msgs };
          });
          break;

        case 'message_end':
          setState(prev => ({ ...prev, messages: msg.messages }));
          break;

        case 'agent_end':
          setState(prev => ({
            ...prev,
            messages: msg.messages,
            isAgentRunning: false,
          }));
          setPendingTools(new Map());
          break;

        case 'tool_pending':
          setPendingTools(prev => {
            const next = new Map(prev);
            next.set(msg.toolName, { toolCallId: msg.toolCallId, args: msg.args });
            return next;
          });
          break;

        case 'tool_resolved':
          setPendingTools(prev => {
            const next = new Map(prev);
            next.delete(msg.toolName);
            return next;
          });
          break;

        case 'session_created':
          sessionIdRef.current = msg.sessionId;
          setState(prev => ({
            ...prev,
            sessionId: msg.sessionId,
            sessionTitle: msg.title,
          }));
          callbacksRef.current.onSessionCreated?.(msg.sessionId, msg.title);
          break;

        case 'session_loaded':
          if (msg.session) {
            sessionIdRef.current = msg.session.id;
            setState(prev => ({
              ...prev,
              sessionId: msg.session!.id,
              sessionTitle: msg.session!.title,
              messages: msg.session!.messages,
              isAgentRunning: false,
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
          console.error('[AgentPort] Error:', msg.error);
          setState(prev => ({ ...prev, isAgentRunning: false, lastError: msg.error }));
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
          lastError: 'Service Worker 连接失败，正在重试…',
        }));
      }
      retryTimer = setTimeout(connect, delay);
    }

    function connect() {
      if (unmounted) return;

      let port: chrome.runtime.Port;
      try {
        port = chrome.runtime.connect({ name: AGENT_PORT_NAME });
      } catch {
        scheduleRetry();
        return;
      }
      portRef.current = port;

      port.onMessage.addListener(handleMessage);

      port.onDisconnect.addListener(() => {
        if (unmounted) return;
        portRef.current = null;
        setState(prev => ({ ...prev, connected: false }));
        scheduleRetry();
      });
    }

    connect();

    return () => {
      unmounted = true;
      if (retryTimer) clearTimeout(retryTimer);
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, []);

  // ─── Actions ───

  const postMessage = useCallback((msg: ClientMessage) => {
    portRef.current?.postMessage(msg);
  }, []);

  const send = useCallback((text: string, attachments?: Attachment[]) => {
    if (!text.trim()) return;
    const sessionId = sessionIdRef.current;
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
        lastError: null,
      };
    });
    postMessage({ type: 'prompt', sessionId, text, attachments });
  }, [postMessage]);

  const cancel = useCallback(() => {
    const sessionId = sessionIdRef.current;
    if (sessionId) postMessage({ type: 'cancel', sessionId });
  }, [postMessage]);

  const subscribe = useCallback((sessionId: string) => {
    sessionIdRef.current = sessionId;
    setState(prev => ({ ...prev, sessionId }));
    postMessage({ type: 'subscribe', sessionId });
  }, [postMessage]);

  const unsubscribe = useCallback(() => {
    sessionIdRef.current = null;
    setState({
      messages: [],
      isAgentRunning: false,
      sessionId: null,
      sessionTitle: '',
      connected: true,
      lastError: null,
    });
    setPendingTools(new Map());
    postMessage({ type: 'unsubscribe' });
  }, [postMessage]);

  const loadSession = useCallback((sessionId: string) => {
    postMessage({ type: 'session_load', sessionId });
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

  return {
    state,
    pendingTools,
    send,
    cancel,
    subscribe,
    unsubscribe,
    loadSession,
    listSessions,
    deleteSession,
    resolveTool,
    cancelTool,
  };
}

import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { createSession, getSession, ThrottledSessionWriter, type SessionRecord } from '@/lib/db';

export interface SessionManager {
  messages: AgentMessage[];
  setMessages: React.Dispatch<React.SetStateAction<AgentMessage[]>>;
  sessionLoading: boolean;
  sessionCreated: React.RefObject<boolean>;
  conversationIdRef: React.RefObject<string | null>;
  writerRef: React.RefObject<ThrottledSessionWriter>;
  /** Persist a newly-created session and navigate to it. */
  persistNewSession: (session: SessionRecord) => Promise<void>;
}

export function useSessionManager(
  isNewChat: boolean,
  routeSessionId: string | undefined,
): SessionManager {
  const navigate = useNavigate();

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [sessionLoading, setSessionLoading] = useState(!isNewChat);

  const sessionCreated = useRef(false);
  const conversationIdRef = useRef<string | null>(isNewChat ? null : routeSessionId!);
  const writerRef = useRef(new ThrottledSessionWriter());

  // Load existing session from DB
  useEffect(() => {
    if (isNewChat) {
      setMessages([]);
      sessionCreated.current = false;
      conversationIdRef.current = null;
      setSessionLoading(false);
      return;
    }

    let cancelled = false;
    setSessionLoading(true);

    getSession(routeSessionId!)
      .then((session) => {
        if (cancelled) return;
        if (session) {
          setMessages(session.messages);
          sessionCreated.current = true;
          conversationIdRef.current = session.id;
        } else {
          navigate('/chat/new', { replace: true });
        }
      })
      .catch((err) => {
        console.error('Failed to load session:', err);
        if (!cancelled) navigate('/chat/new', { replace: true });
      })
      .finally(() => {
        if (!cancelled) setSessionLoading(false);
      });

    return () => { cancelled = true; };
  }, [routeSessionId, isNewChat, navigate]);

  // Cleanup writer on unmount
  useEffect(() => {
    const writer = writerRef.current;
    return () => writer.dispose();
  }, []);

  const persistNewSession = useCallback(async (session: SessionRecord) => {
    try {
      await createSession(session);
      conversationIdRef.current = session.id;
      sessionCreated.current = true;
      navigate(`/chat/${session.id}`, { replace: true });
    } catch (err) {
      console.error('Failed to create session:', err);
    }
  }, [navigate]);

  return {
    messages,
    setMessages,
    sessionLoading,
    sessionCreated,
    conversationIdRef,
    writerRef,
    persistNewSession,
  };
}

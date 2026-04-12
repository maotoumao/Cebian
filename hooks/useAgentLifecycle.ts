import { useState, useRef, useEffect, useCallback } from 'react';
import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import { createCebianAgent } from '@/lib/agent';
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/constants';
import type { ThrottledSessionWriter, SessionRecord } from '@/lib/db';
import { interactiveToolRegistry } from '@/lib/tools/registry';
import { extractUserText } from '@/lib/message-helpers';
import { gatherPageContext } from '@/lib/page-context';
import { buildTextPrefix, extractImages, type Attachment } from '@/lib/attachments';

// ─── Types ───

export interface AgentConfig {
  systemPrompt: string;
  thinkingLevel: string;
  maxRounds: number;
  currentModel: { provider: string; modelId: string } | null;
}

export interface AgentLifecycle {
  agentRef: React.RefObject<Agent | null>;
  isAgentRunning: boolean;
  handleSend: (text: string, attachments?: Attachment[]) => void;
}

// ─── Hook ───

export function useAgentLifecycle(opts: {
  modelObj: Model<Api> | undefined;
  isNewChat: boolean;
  sessionLoading: boolean;
  messages: AgentMessage[];
  setMessages: React.Dispatch<React.SetStateAction<AgentMessage[]>>;
  config: AgentConfig;
  sessionCreated: React.RefObject<boolean>;
  conversationIdRef: React.RefObject<string | null>;
  writerRef: React.RefObject<ThrottledSessionWriter>;
  persistNewSession: (session: SessionRecord) => Promise<void>;
  routeSessionId: string | undefined;
}): AgentLifecycle {
  const {
    modelObj,
    isNewChat,
    sessionLoading,
    messages,
    setMessages,
    config,
    sessionCreated,
    conversationIdRef,
    writerRef,
    persistNewSession,
    routeSessionId,
  } = opts;

  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const agentRef = useRef<Agent | null>(null);

  // Batch config sync into a single ref + single effect
  const configRef = useRef(config);
  useEffect(() => {
    configRef.current = config;
    if (agentRef.current) {
      agentRef.current.state.systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
      agentRef.current.state.thinkingLevel = config.thinkingLevel as any;
    }
  }, [config.systemPrompt, config.thinkingLevel, config.maxRounds, config.currentModel]);

  // Create agent (only when model or route session changes)
  useEffect(() => {
    if (!modelObj || sessionLoading) return;

    const agent = createCebianAgent({
      model: modelObj,
      systemPrompt: configRef.current.systemPrompt,
      thinkingLevel: configRef.current.thinkingLevel as any,
      maxRounds: configRef.current.maxRounds,
      messages: isNewChat ? [] : messages,
    });

    const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      switch (event.type) {
        case 'agent_start':
          setIsAgentRunning(true);
          break;

        case 'message_start':
        case 'message_end':
          setMessages([...agent.state.messages]);
          if (event.type === 'message_end' && sessionCreated.current && conversationIdRef.current) {
            writerRef.current.schedule(conversationIdRef.current, agent.state.messages);
          }
          break;

        case 'message_update':
          if ('role' in event.message && event.message.role === 'assistant') {
            setMessages(prev => {
              const last = prev[prev.length - 1];
              if (last && 'role' in last && last.role === 'assistant') {
                const updated = [...prev];
                updated[updated.length - 1] = event.message;
                return updated;
              }
              return [...prev, event.message];
            });
          }
          break;

        case 'agent_end': {
          setIsAgentRunning(false);
          setMessages([...agent.state.messages]);

          if (!sessionCreated.current && agent.state.messages.length > 0) {
            const firstUserText = extractUserText(agent.state.messages[0]);
            const title = firstUserText.slice(0, 50) + (firstUserText.length > 50 ? '...' : '');
            const session: SessionRecord = {
              id: crypto.randomUUID(),
              title: title || '新对话',
              model: configRef.current.currentModel?.modelId ?? '',
              provider: configRef.current.currentModel?.provider ?? '',
              systemPrompt: configRef.current.systemPrompt,
              thinkingLevel: configRef.current.thinkingLevel,
              messageCount: agent.state.messages.length,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalCost: 0,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              messages: agent.state.messages,
            };
            await persistNewSession(session);
          } else if (conversationIdRef.current) {
            await writerRef.current.flush();
          }
          break;
        }
      }
    });

    agentRef.current = agent;

    return () => {
      unsubscribe();
      agent.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelObj, routeSessionId, sessionLoading]);

  // Send message — generic interactive tool handling via followUp
  const handleSend = useCallback((text: string, attachments: Attachment[] = []) => {
    if (!agentRef.current || !modelObj || !text.trim()) return;

    const trimmed = text.trim();
    // Lock immediately to prevent double-sends during async context gathering
    setIsAgentRunning(true);

    /** Build enriched text: [pageContext] + [attachmentPrefix] + [userText] */
    const buildEnrichedText = (ctx: string): string => {
      const parts: string[] = [];
      if (ctx) parts.push(ctx);
      const prefix = buildTextPrefix(attachments);
      if (prefix) parts.push(prefix);
      if (trimmed) parts.push(trimmed);
      return parts.join('\n\n');
    };

    const images = extractImages(attachments);

    // If any interactive tool is pending, cancel all and steer with user message.
    // IMPORTANT: gather context BEFORE cancelAll, because cancelAll unblocks the agent
    // loop which will drain the steering queue. If we steer after an async gap
    // (e.g. gatherPageContext), the queue may be drained before we enqueue.
    if (interactiveToolRegistry.hasPending()) {
      gatherPageContext().then((ctx) => {
        const agent = agentRef.current;
        if (!agent) return;
        const enriched = buildEnrichedText(ctx);
        const content: any[] = [{ type: 'text', text: enriched }];
        if (images.length > 0) content.push(...images);
        const userMessage: AgentMessage = {
          role: 'user',
          content,
          timestamp: Date.now(),
        } as AgentMessage;
        // Enqueue BEFORE cancelling so getSteeringMessages() sees it when the loop drains.
        agent.steer(userMessage);
        interactiveToolRegistry.cancelAll();
      }).catch((err) => {
        console.error('Agent steer failed:', err);
        setIsAgentRunning(false);
      });
      return;
    }

    gatherPageContext().then((ctx) => {
      const agent = agentRef.current;
      if (!agent) return;
      const enriched = buildEnrichedText(ctx);
      agent.prompt(enriched, images.length > 0 ? images : undefined).catch((err) => {
        console.error('Agent prompt failed:', err);
        setIsAgentRunning(false);
      });
    }).catch((err) => {
      console.error('Context gathering failed:', err);
      setIsAgentRunning(false);
    });
  }, [modelObj]);

  return { agentRef, isAgentRunning, handleSend };
}

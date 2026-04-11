import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { SquarePen } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChatInput } from '@/components/chat/ChatInput';
import {
  UserMessageBubble,
  AgentMessage,
  AgentTextBlock,
  ThinkingBlock,
} from '@/components/chat/Message';
import { Agent, type AgentEvent, type AgentMessage as AgentMessageType } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import { getAssistantText, getThinkingBlocks } from '@/lib/types';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  activeModel,
  thinkingLevel,
  providerCredentials,
  customProviders as customProvidersStorage,
  systemPrompt as systemPromptStorage,
  maxRounds as maxRoundsStorage,
} from '@/lib/storage';
import { createCebianAgent, DEFAULT_SYSTEM_PROMPT } from '@/lib/agent';
import { mergeCustomProviders, isCustomProvider, findCustomModel } from '@/lib/custom-models';
import { PRESET_PROVIDERS } from '@/lib/constants';
import { createSession, getSession, ThrottledSessionWriter, type SessionRecord } from '@/lib/db';
import { getModels, type KnownProvider, type Api, type Model } from '@mariozechner/pi-ai';

// ─── Helpers ───

function getModelForProvider(
  provider: string,
  modelId: string,
  customProviders: import('@/lib/storage').CustomProviderConfig[],
): Model<Api> | undefined {
  if (isCustomProvider(provider)) {
    return findCustomModel(customProviders, provider, modelId) ?? undefined;
  }
  try {
    const models = getModels(provider as KnownProvider) as Model<Api>[];
    return models.find(m => m.id === modelId);
  } catch {
    return undefined;
  }
}

function extractUserText(msg: AgentMessageType): string {
  if (!('role' in msg) || msg.role !== 'user') return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b): b is { type: 'text'; text: string } => 'type' in b && b.type === 'text')
      .map(b => b.text)
      .join('');
  }
  return '';
}

// ─── ChatPage ───

export function ChatPage({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();

  const isNewChat = !routeSessionId || routeSessionId === 'new';

  const [messages, setMessages] = useState<AgentMessageType[]>([]);
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(!isNewChat);

  const scrollRef = useRef<HTMLDivElement>(null);
  const agentRef = useRef<Agent | null>(null);
  const sessionCreated = useRef(false);
  const conversationIdRef = useRef<string | null>(isNewChat ? null : routeSessionId!);
  const writerRef = useRef(new ThrottledSessionWriter());

  // Load existing session from DB
  useEffect(() => {
    if (isNewChat) {
      // Reset state for new chat
      setMessages([]);
      sessionCreated.current = false;
      conversationIdRef.current = null;
      setSessionLoading(false);
      return;
    }

    // Load a historical session
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
          // Invalid sessionId — redirect to new chat
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

  // Storage values
  const [currentModel] = useStorageItem(activeModel, null);
  const [currentThinkingLevel] = useStorageItem(thinkingLevel, 'medium');
  const [providers] = useStorageItem(providerCredentials, {});
  const [customProviderList] = useStorageItem(customProvidersStorage, []);
  const [currentSystemPrompt] = useStorageItem(systemPromptStorage, '');
  const [currentMaxRounds] = useStorageItem(maxRoundsStorage, 200);

  // Refs for config values (avoid agent rebuild on config change)
  const systemPromptRef = useRef(currentSystemPrompt);
  const thinkingLevelRef = useRef(currentThinkingLevel);
  const maxRoundsRef = useRef(currentMaxRounds);
  const currentModelRef = useRef(currentModel);

  // Sync refs + dynamically update agent state
  useEffect(() => {
    systemPromptRef.current = currentSystemPrompt;
    if (agentRef.current) {
      agentRef.current.state.systemPrompt = currentSystemPrompt || DEFAULT_SYSTEM_PROMPT;
    }
  }, [currentSystemPrompt]);

  useEffect(() => {
    thinkingLevelRef.current = currentThinkingLevel;
    if (agentRef.current) {
      agentRef.current.state.thinkingLevel = currentThinkingLevel as 'off' | 'minimal' | 'low' | 'medium' | 'high';
    }
  }, [currentThinkingLevel]);

  useEffect(() => {
    maxRoundsRef.current = currentMaxRounds;
  }, [currentMaxRounds]);

  useEffect(() => {
    currentModelRef.current = currentModel;
  }, [currentModel]);

  const allCustomProviders = useMemo(() =>
    mergeCustomProviders(PRESET_PROVIDERS, customProviderList),
  [customProviderList]);

  // Resolve current model object
  const modelObj = useMemo(() => {
    if (!currentModel) return undefined;
    return getModelForProvider(currentModel.provider, currentModel.modelId, allCustomProviders);
  }, [currentModel, allCustomProviders]);

  // Auto-scroll helper
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      const viewport = el.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Create agent (only when model or route session changes)
  useEffect(() => {
    if (!modelObj || sessionLoading) return;

    const agent = createCebianAgent({
      model: modelObj,
      systemPrompt: systemPromptRef.current,
      thinkingLevel: thinkingLevelRef.current as 'off' | 'minimal' | 'low' | 'medium' | 'high',
      maxRounds: maxRoundsRef.current,
      messages,
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
              if ('role' in last && last.role === 'assistant') {
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
            // First agent response — generate ID, persist, and replace route
            const newId = crypto.randomUUID();
            conversationIdRef.current = newId;
            sessionCreated.current = true;

            const firstUserText = extractUserText(agent.state.messages[0]);
            const title = firstUserText.slice(0, 50) + (firstUserText.length > 50 ? '...' : '');
            const session: SessionRecord = {
              id: newId,
              title: title || '新对话',
              model: currentModelRef.current?.modelId ?? '',
              provider: currentModelRef.current?.provider ?? '',
              systemPrompt: systemPromptRef.current,
              thinkingLevel: thinkingLevelRef.current,
              messageCount: agent.state.messages.length,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalCost: 0,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              messages: agent.state.messages,
            };
            try {
              await createSession(session);
              navigate(`/chat/${newId}`, { replace: true });
            } catch (err) {
              console.error('Failed to create session:', err);
              // Reset so next agent_end can retry
              sessionCreated.current = false;
              conversationIdRef.current = null;
            }
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
    // Only rebuild agent when model or route session changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelObj, routeSessionId, sessionLoading]);

  // Cleanup writer on unmount
  useEffect(() => {
    const writer = writerRef.current;
    return () => writer.dispose();
  }, []);

  // Send message
  const handleSend = useCallback(async (text: string) => {
    if (!agentRef.current || !modelObj || !text.trim()) return;

    try {
      await agentRef.current.prompt(text);
    } catch (err) {
      console.error('Agent prompt failed:', err);
      setIsAgentRunning(false);
    }
  }, [modelObj]);

  return (
    <>
      <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
        <div className="flex flex-col gap-6 p-5">
          {sessionLoading && (
            <div className="text-center text-sm text-muted-foreground py-12">
              加载会话中…
            </div>
          )}

          {!sessionLoading && messages.map((msg, idx) => {
            if (!('role' in msg)) return null;

            if (msg.role === 'user') {
              return (
                <UserMessageBubble key={`msg-${idx}`}>
                  {extractUserText(msg)}
                </UserMessageBubble>
              );
            }

            if (msg.role === 'assistant') {
              const assistantMsg = msg as AssistantMessage;
              const thinkingBlocks = getThinkingBlocks(assistantMsg);
              const text = getAssistantText(assistantMsg);
              const isLast = idx === messages.length - 1;
              const isStreaming = isLast && isAgentRunning;
              const isError = assistantMsg.stopReason === 'error';

              return (
                <AgentMessage key={`msg-${idx}`} isStreaming={isStreaming}>
                  {thinkingBlocks.map((block, i) => (
                    <ThinkingBlock key={`t-${idx}-${i}`} content={block.thinking} isLive={isStreaming} />
                  ))}
                  {text && <AgentTextBlock content={text} />}
                  {isError && (
                    <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2 mt-2">
                      {assistantMsg.errorMessage ?? '模型返回错误'}
                    </div>
                  )}
                </AgentMessage>
              );
            }

            return null;
          })}

          {/* Waiting placeholder: show after user sends, before assistant responds */}
          {isAgentRunning && messages.length > 0 && 'role' in messages[messages.length - 1] && messages[messages.length - 1].role === 'user' && (
            <AgentMessage isStreaming />
          )}

          {!sessionLoading && messages.length === 0 && !isAgentRunning && (
            <div className="flex flex-col items-center gap-3 pt-24 pb-12 text-center">
              <div className="w-10 h-10 rounded-xl bg-primary/10 grid place-items-center">
                <SquarePen className="size-5 text-primary" />
              </div>
              {!modelObj ? (
                <p className="text-sm text-muted-foreground">请先选择一个 AI 模型</p>
              ) : (
                <p className="text-sm text-muted-foreground">有什么我可以帮你的？</p>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      <ChatInput onSend={handleSend} onOpenSettings={onOpenSettings} />
    </>
  );
}

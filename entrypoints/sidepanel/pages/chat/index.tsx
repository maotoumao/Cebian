import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
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
import { createSession, ThrottledSessionWriter, type SessionRecord } from '@/lib/db';
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
  const [conversationId] = useState(() => crypto.randomUUID());
  const [messages, setMessages] = useState<AgentMessageType[]>([]);
  const [isAgentRunning, setIsAgentRunning] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const agentRef = useRef<Agent | null>(null);
  const sessionCreated = useRef(false);
  const writerRef = useRef(new ThrottledSessionWriter());

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
      // ScrollArea viewport is the first child with data-slot="scroll-area-viewport"
      const viewport = el.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Create agent (only when model or conversation changes)
  useEffect(() => {
    if (!modelObj) return;

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
          if (event.type === 'message_end' && sessionCreated.current) {
            writerRef.current.schedule(conversationId, agent.state.messages);
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
            sessionCreated.current = true;
            const firstUserText = extractUserText(agent.state.messages[0]);
            const title = firstUserText.slice(0, 50) + (firstUserText.length > 50 ? '...' : '');
            const session: SessionRecord = {
              id: conversationId,
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
            await createSession(session);
          } else {
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
    // Only rebuild agent when model or conversation changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelObj, conversationId]);

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
      setIsAgentRunning(false);
    }
  }, [modelObj]);

  return (
    <>
      <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
        <div className="flex flex-col gap-6 p-5">
          {messages.map((msg, idx) => {
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

          {!modelObj && messages.length === 0 && (
            <div className="text-center text-sm text-muted-foreground py-12">
              请先选择一个 AI 模型
            </div>
          )}
        </div>
      </ScrollArea>

      <ChatInput onSend={handleSend} onOpenSettings={onOpenSettings} />
    </>
  );
}

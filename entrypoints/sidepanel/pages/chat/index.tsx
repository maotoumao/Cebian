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
import { createCebianAgent } from '@/lib/agent';
import { mergeCustomProviders, isCustomProvider, findCustomModel } from '@/lib/custom-models';
import { PRESET_PROVIDERS } from '@/lib/constants';
import { createConversation, saveMessage } from '@/lib/db';
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
  const [streamingMessage, setStreamingMessage] = useState<AssistantMessage | null>(null);
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const agentRef = useRef<Agent | null>(null);
  const conversationCreated = useRef(false);

  // Storage values
  const [currentModel] = useStorageItem(activeModel, null);
  const [currentThinkingLevel] = useStorageItem(thinkingLevel, 'medium');
  const [providers] = useStorageItem(providerCredentials, {});
  const [customProviderList] = useStorageItem(customProvidersStorage, []);
  const [currentSystemPrompt] = useStorageItem(systemPromptStorage, '');
  const [currentMaxRounds] = useStorageItem(maxRoundsStorage, 200);

  const allCustomProviders = useMemo(() =>
    mergeCustomProviders(PRESET_PROVIDERS, customProviderList),
  [customProviderList]);

  // Resolve current model object
  const modelObj = useMemo(() => {
    if (!currentModel) return undefined;
    return getModelForProvider(currentModel.provider, currentModel.modelId, allCustomProviders);
  }, [currentModel, allCustomProviders]);

  // Auto-scroll on message changes
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingMessage]);

  // Create / update agent when config changes
  useEffect(() => {
    if (!modelObj) return;

    const agent = createCebianAgent({
      model: modelObj,
      systemPrompt: currentSystemPrompt,
      thinkingLevel: currentThinkingLevel as 'off' | 'minimal' | 'low' | 'medium' | 'high',
      maxRounds: currentMaxRounds,
      messages,
    });

    const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      switch (event.type) {
        case 'agent_start':
          setIsAgentRunning(true);
          setError(null);
          break;

        case 'message_update':
          if ('role' in event.message && (event.message as AssistantMessage).role === 'assistant') {
            setStreamingMessage(event.message as AssistantMessage);
          }
          break;

        case 'message_end':
          setStreamingMessage(null);
          setMessages([...agent.state.messages]);
          // Create conversation on first persisted message
          if (!conversationCreated.current) {
            conversationCreated.current = true;
            const firstUserText = extractUserText(agent.state.messages[0]);
            const title = firstUserText.slice(0, 50) + (firstUserText.length > 50 ? '...' : '');
            await createConversation(conversationId, title || '新对话', currentModel?.modelId ?? '', currentModel?.provider ?? '');
          }
          await saveMessage(conversationId, event.message);
          break;

        case 'agent_end':
          setIsAgentRunning(false);
          setMessages([...agent.state.messages]);
          break;
      }
    });

    agentRef.current = agent;

    return () => {
      setStreamingMessage(null);
      unsubscribe();
      agent.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelObj, currentSystemPrompt, currentThinkingLevel, currentMaxRounds, conversationId]);

  // Send message
  const handleSend = useCallback(async (text: string) => {
    if (!agentRef.current || !modelObj || !text.trim()) return;

    try {
      await agentRef.current.prompt(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败');
      setIsAgentRunning(false);
    }
  }, [modelObj, conversationId, currentModel]);

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

              return (
                <AgentMessage key={`msg-${idx}`}>
                  {thinkingBlocks.map((block, i) => (
                    <ThinkingBlock key={i} content={block.thinking} />
                  ))}
                  {text && <AgentTextBlock content={text} />}
                </AgentMessage>
              );
            }

            return null;
          })}

          {streamingMessage && (
            <AgentMessage isStreaming>
              {getThinkingBlocks(streamingMessage).map((block, i) => (
                <ThinkingBlock key={i} content={block.thinking} />
              ))}
              {getAssistantText(streamingMessage) && (
                <AgentTextBlock content={getAssistantText(streamingMessage)} />
              )}
            </AgentMessage>
          )}

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3">
              {error}
            </div>
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

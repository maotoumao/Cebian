import { useRef, useEffect, useMemo, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { SquarePen } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChatInput } from '@/components/chat/ChatInput';
import {
  UserMessageBubble,
  AgentMessage,
  AgentTextBlock,
  ThinkingBlock,
} from '@/components/chat/Message';
import type { AgentMessage as AgentMessageType } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, ToolResultMessage } from '@mariozechner/pi-ai';
import { getAssistantText, getThinkingBlocks, getToolCalls, findToolResult, extractUserText } from '@/lib/types';
import { useInteractiveTools } from '@/hooks/useInteractiveTools';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  activeModel,
  thinkingLevel,
  customProviders as customProvidersStorage,
  systemPrompt as systemPromptStorage,
  maxRounds as maxRoundsStorage,
} from '@/lib/storage';
import { mergeCustomProviders, isCustomProvider, findCustomModel } from '@/lib/custom-models';
import { PRESET_PROVIDERS } from '@/lib/constants';
import { useSessionManager } from '@/hooks/useSessionManager';
import { useAgentLifecycle } from '@/hooks/useAgentLifecycle';
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

// ─── ChatPage ───

export function ChatPage({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const isNewChat = !routeSessionId || routeSessionId === 'new';

  // Storage values
  const [currentModel] = useStorageItem(activeModel, null);
  const [currentThinkingLevel] = useStorageItem(thinkingLevel, 'medium');
  const [customProviderList] = useStorageItem(customProvidersStorage, []);
  const [currentSystemPrompt] = useStorageItem(systemPromptStorage, '');
  const [currentMaxRounds] = useStorageItem(maxRoundsStorage, 200);

  const allCustomProviders = useMemo(() =>
    mergeCustomProviders(PRESET_PROVIDERS, customProviderList),
  [customProviderList]);

  const modelObj = useMemo(() => {
    if (!currentModel) return undefined;
    return getModelForProvider(currentModel.provider, currentModel.modelId, allCustomProviders);
  }, [currentModel, allCustomProviders]);

  // Session management
  const session = useSessionManager(isNewChat, routeSessionId);

  // Agent config (batched as a single object)
  const agentConfig = useMemo(() => ({
    systemPrompt: currentSystemPrompt,
    thinkingLevel: currentThinkingLevel,
    maxRounds: currentMaxRounds,
    currentModel,
  }), [currentSystemPrompt, currentThinkingLevel, currentMaxRounds, currentModel]);

  // Agent lifecycle
  const { isAgentRunning, handleSend } = useAgentLifecycle({
    modelObj,
    isNewChat,
    sessionLoading: session.sessionLoading,
    messages: session.messages,
    setMessages: session.setMessages,
    config: agentConfig,
    sessionCreated: session.sessionCreated,
    conversationIdRef: session.conversationIdRef,
    writerRef: session.writerRef,
    persistNewSession: session.persistNewSession,
    routeSessionId,
  });

  // Interactive tools (generic — no tool-specific code)
  const { getToolInfo, getPendingFor, resolve } = useInteractiveTools();

  // Auto-scroll
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      const viewport = el.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
  }, []);
  useEffect(() => { scrollToBottom(); }, [session.messages, scrollToBottom]);

  const { messages, sessionLoading } = session;
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const showWaitingPlaceholder = isAgentRunning && lastMsg && 'role' in lastMsg && lastMsg.role === 'user';

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
                <UserMessageBubble key={`user-${idx}`}>
                  {extractUserText(msg)}
                </UserMessageBubble>
              );
            }

            if (msg.role === 'assistant') {
              const assistantMsg = msg as AssistantMessage;
              const thinkingBlocks = getThinkingBlocks(assistantMsg);
              const text = getAssistantText(assistantMsg);
              const toolCalls = getToolCalls(assistantMsg);
              const isLast = idx === messages.length - 1;
              const isStreaming = isLast && isAgentRunning;
              const isError = assistantMsg.stopReason === 'error';

              return (
                <AgentMessage key={`asst-${idx}`} isStreaming={isStreaming}>
                  {thinkingBlocks.map((block, i) => (
                    <ThinkingBlock key={`t-${idx}-${i}`} content={block.thinking} isLive={isStreaming} />
                  ))}
                  {text && <AgentTextBlock content={text} />}
                  {isError && (
                    <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2 mt-2">
                      {assistantMsg.errorMessage ?? '模型返回错误'}
                    </div>
                  )}
                  {/* Generic interactive tool rendering */}
                  {toolCalls.map((tc) => {
                    const info = getToolInfo(tc.name);
                    if (!info) return null;
                    const pending = getPendingFor(tc.name);
                    const isPending = pending?.toolCallId === tc.id;
                    const toolResult = findToolResult(messages, tc.id);
                    return (
                      <info.Component
                        key={`tool-${tc.id}`}
                        toolCallId={tc.id}
                        args={tc.arguments}
                        isPending={isPending}
                        toolResult={toolResult}
                        onResolve={isPending ? (response: any) => resolve(tc.name, response) : undefined}
                      />
                    );
                  })}
                </AgentMessage>
              );
            }

            // Generic: render interactive tool results as user bubbles
            if (msg.role === 'toolResult') {
              const tr = msg as ToolResultMessage;
              const info = getToolInfo(tr.toolName);
              if (info?.renderResultAsUserBubble && !tr.details?.cancelled) {
                const text = tr.content
                  .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                  .map(b => b.text)
                  .join('');
                if (text) {
                  return (
                    <UserMessageBubble key={`tr-${idx}`}>
                      {text}
                    </UserMessageBubble>
                  );
                }
              }
              return null;
            }

            return null;
          })}

          {/* Waiting placeholder */}
          {showWaitingPlaceholder && (
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

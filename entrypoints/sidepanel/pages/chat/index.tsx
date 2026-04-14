import { useRef, useEffect, useCallback } from 'react';
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
import { ToolCard } from '@/components/chat/ToolCard';
import type { AssistantMessage, ToolResultMessage } from '@mariozechner/pi-ai';
import { getAssistantText, getThinkingBlocks, getToolCalls, findToolResult } from '@/lib/message-helpers';
import { getToolLabel } from '@/lib/tools/tool-labels';
import { uiToolRegistry } from '@/lib/tools/ui-registry';
import { useBackgroundAgent } from '@/hooks/useBackgroundAgent';
import { useStorageItem } from '@/hooks/useStorageItem';
import { activeModel } from '@/lib/storage';
import type { SessionRecord } from '@/lib/db';

// ─── ChatPage ───

export function ChatPage({ onOpenSettings, onTitleChange }: { onOpenSettings?: () => void; onTitleChange?: (title: string) => void }) {
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const isNewChat = !routeSessionId || routeSessionId === 'new';
  const navigate = useNavigate();

  // Only read activeModel for UI display (is a model selected?)
  const [currentModel] = useStorageItem(activeModel, null);

  // ─── Agent port (all agent/session logic via background) ───
  const {
    state,
    pendingTools,
    send,
    cancel,
    subscribe: portSubscribe,
    unsubscribe: portUnsubscribe,
    resolveTool,
  } = useBackgroundAgent({
    onSessionCreated: useCallback((sessionId: string, title: string) => {
      onTitleChange?.(title);
      navigate(`/chat/${sessionId}`, { replace: true });
    }, [navigate, onTitleChange]),
    onSessionLoaded: useCallback((session: SessionRecord | null) => {
      if (!session) {
        navigate('/chat/new', { replace: true });
      }
    }, [navigate]),
  });

  const { messages, isAgentRunning, sessionId: activeSessionId, sessionTitle, lastError } = state;

  // Subscribe to existing session or unsubscribe for new chat
  useEffect(() => {
    if (isNewChat) {
      portUnsubscribe();
      return;
    }
    if (routeSessionId) {
      portSubscribe(routeSessionId);
    }
  }, [routeSessionId, isNewChat, portSubscribe, portUnsubscribe]);

  // Sync session title to parent
  useEffect(() => {
    onTitleChange?.(sessionTitle);
  }, [sessionTitle, onTitleChange]);

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
  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const showWaitingPlaceholder = isAgentRunning && lastMsg && 'role' in lastMsg && lastMsg.role === 'user';

  // Session loading state: we're loading if a session route is targeted but no messages or state yet
  const sessionLoading = !isNewChat && routeSessionId !== activeSessionId && messages.length === 0;

  return (
    <>
      <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
        <div className="flex flex-col gap-4 p-5">
          {sessionLoading && (
            <div className="text-center text-sm text-muted-foreground py-12">
              加载会话中…
            </div>
          )}

          {!sessionLoading && messages.map((msg, idx) => {
            if (!('role' in msg)) return null;

            if (msg.role === 'user') {
              return (
                <UserMessageBubble key={`user-${idx}`} msg={msg} />
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

              // Show header only for the first assistant message in a consecutive group
              let showHeader = true;
              for (let i = idx - 1; i >= 0; i--) {
                const prev = messages[i];
                if (!('role' in prev)) continue;
                if (prev.role === 'toolResult') {
                  const tr = prev as ToolResultMessage;
                  const info = uiToolRegistry.get(tr.toolName);
                  if (info?.renderResultAsUserBubble && !tr.details?.cancelled) break;
                  continue;
                }
                if (prev.role === 'assistant') showHeader = false;
                break;
              }

              return (
                <AgentMessage key={`asst-${idx}`} isStreaming={isStreaming} showHeader={showHeader}>
                  {thinkingBlocks.map((block, i) => (
                    <ThinkingBlock key={`t-${idx}-${i}`} content={block.thinking} isLive={isStreaming} />
                  ))}
                  {text && <AgentTextBlock content={text} />}
                  {isError && (
                    <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2 mt-2">
                      {assistantMsg.errorMessage ?? '模型返回错误'}
                    </div>
                  )}
                  {/* Generic tool rendering */}
                  {toolCalls.map((tc) => {
                    const uiInfo = uiToolRegistry.get(tc.name);

                    // Interactive tool — render via UI registry
                    if (uiInfo) {
                      const pending = pendingTools.get(tc.name);
                      const isPending = !!pending && pending.toolCallId === tc.id;
                      const toolResult = findToolResult(messages, tc.id);
                      return (
                        <uiInfo.Component
                          key={`tool-${tc.id}`}
                          toolCallId={tc.id}
                          args={tc.arguments}
                          isPending={isPending}
                          toolResult={toolResult}
                          onResolve={isPending ? (response: any) => resolveTool(tc.name, response) : undefined}
                        />
                      );
                    }

                    // Non-interactive tool — render as ToolCard
                    const toolResult = findToolResult(messages, tc.id);
                    const status = toolResult
                      ? (toolResult.isError ? 'error' : 'done')
                      : 'running';
                    const label = getToolLabel(tc.name, tc.arguments);
                    const argsStr = JSON.stringify(tc.arguments, null, 2);
                    const resultText = toolResult
                      ? toolResult.content
                          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                          .map(b => b.text)
                          .join('\n') || undefined
                      : undefined;
                    const resultImages = toolResult
                      ? toolResult.content
                          .filter((b): b is { type: 'image'; data: string; mimeType: string } => b.type === 'image')
                      : undefined;
                    return (
                      <ToolCard
                        key={`tool-${tc.id}`}
                        label={label}
                        status={status}
                        args={argsStr}
                        result={resultText}
                        images={resultImages}
                      />
                    );
                  })}
                </AgentMessage>
              );
            }

            // Generic: render interactive tool results as user bubbles
            if (msg.role === 'toolResult') {
              const tr = msg as ToolResultMessage;
              const info = uiToolRegistry.get(tr.toolName);
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

          {/* Error display */}
          {lastError && !isAgentRunning && (
            <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
              {lastError}
            </div>
          )}

          {!sessionLoading && messages.length === 0 && !isAgentRunning && (
            <div className="flex flex-col items-center gap-3 pt-24 pb-12 text-center">
              <div className="w-10 h-10 rounded-xl bg-primary/10 grid place-items-center">
                <SquarePen className="size-5 text-primary" />
              </div>
              {!currentModel ? (
                <p className="text-sm text-muted-foreground">请先选择一个 AI 模型</p>
              ) : (
                <p className="text-sm text-muted-foreground">有什么我可以帮你的？</p>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      <ChatInput onSend={send} onCancel={cancel} isAgentRunning={isAgentRunning} onOpenSettings={onOpenSettings} />
    </>
  );
}

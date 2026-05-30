import { useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { SquarePen, ArrowDown } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ChatInput } from '@/components/chat/ChatInput';
import {
  UserMessageBubble,
  AgentMessage,
  AgentTextBlock,
  ThinkingBlock,
} from '@/components/chat/Message';
import { ToolCard } from '@/components/chat/ToolCard';
import { ToolCardWithUI } from '@/components/chat/ToolCardWithUI';
import { isMcpAppResult } from '@/lib/tools/mcp-tool';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  getAssistantText,
  getThinkingBlocks,
  getToolCalls,
  findToolResult,
  extractUserText,
} from '@/lib/message-helpers';
import { getToolLabel } from '@/lib/tools/tool-labels';
import { uiToolRegistry } from '@/lib/tools/ui-registry';
import { useBackgroundAgent } from '@/hooks/useBackgroundAgent';
import { useStickToBottom } from '@/hooks/useStickToBottom';
import { useStorageItem } from '@/hooks/useStorageItem';
import { activeModel } from '@/lib/storage';
import type { Attachment } from '@/lib/attachments';
import type { SessionRecord } from '@/lib/db';
import { t } from '@/lib/i18n';

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
    retry,
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

  // Mirror activeSessionId into a ref so the subscribe-effect can read the
  // latest value WITHOUT re-running when activeSessionId changes. Putting
  // activeSessionId in the effect's deps would cause an extra run between
  // session_created (which sets state.sessionId) and navigate (which sets
  // routeSessionId) — at that point isNewChat is still true, so the effect
  // would hit portUnsubscribe() and wipe the optimistic user message.
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;

  // When an interactive tool (e.g. ask_user) is pending, the agent is blocked
  // waiting for user input — treat as "not running" so the input is usable.
  // Sending a message during this state triggers steer + cancelAll in the
  // background agent manager automatically.
  const effectiveRunning = isAgentRunning && pendingTools.size === 0;

  // Subscribe to existing session or unsubscribe for new chat.
  //
  // Skip the subscribe IPC when the hook already considers this id active
  // (`activeSessionId === routeSessionId`). That's the case right after
  // sending the first message in a new chat: session_created set
  // state.sessionId to the new id, and the BG port's subscribedSession was
  // already pinned by the 'prompt' handler — we're implicitly subscribed.
  // A redundant 'subscribe' here would race with the in-flight
  // getOrCreateAgent: BG would fall through to a DB load of the just-written
  // empty row and reply with session_loaded{messages:[]}, clobbering the
  // optimistic user message and briefly flashing the welcome screen.
  useEffect(() => {
    if (isNewChat) {
      portUnsubscribe();
      return;
    }
    if (routeSessionId && routeSessionId !== activeSessionIdRef.current) {
      portSubscribe(routeSessionId);
    }
  }, [routeSessionId, isNewChat, portSubscribe, portUnsubscribe]);

  // Sync session title to parent
  useEffect(() => {
    onTitleChange?.(sessionTitle);
  }, [sessionTitle, onTitleChange]);

  // Auto-scroll: stick to bottom while content streams, but stop following
  // as soon as the user scrolls up. Resumes when the user scrolls back near
  // the bottom. Driven internally by ResizeObserver, so no `messages`-dep
  // effect needed here.
  const { scrollRef, isAtBottom, scrollToBottom } = useStickToBottom();

  // Force-pin to bottom when switching sessions or opening a fresh chat.
  useEffect(() => {
    scrollToBottom({ force: true });
  }, [activeSessionId, isNewChat, scrollToBottom]);

  // Force-pin when the user sends a new message — sending is an explicit
  // intent to see the latest output.
  const handleSend = useCallback(
    async (text: string, attachments: Attachment[] | undefined, expectedSessionId: string | null) => {
      const result = await send(text, attachments, expectedSessionId);
      if (result.status === 'dispatched') {
        scrollToBottom({ force: true });
      }
      return result;
    },
    [scrollToBottom, send],
  );

  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const showWaitingPlaceholder = effectiveRunning && lastMsg && 'role' in lastMsg && lastMsg.role === 'user';

  // History of user-typed prompts in this session, oldest first; consumed by
  // ChatInput's ↑/↓ navigation. Strips the <user-request> wrapper added by
  // buildStructuredMessage so what comes back is exactly what the user typed.
  const userHistory = useMemo(
    () => messages
      .filter((m): m is UserMessage => 'role' in m && m.role === 'user')
      .map(extractUserText)
      .filter((s) => s.length > 0),
    [messages],
  );

  // Session loading state: any route/state mismatch means the current
  // message array belongs to a different chat and must not be rendered.
  const sessionLoading = !isNewChat && routeSessionId !== activeSessionId;

  return (
    <>
      <div className="flex-1 min-h-0 relative flex flex-col">
        <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
          <div className="flex flex-col gap-4 p-5">
            {sessionLoading && (
              <div className="text-center text-sm text-muted-foreground py-12">
                {t('chat.session.loading')}
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
              const isStreaming = isLast && effectiveRunning;
              const isError = assistantMsg.stopReason === 'error';
              // Aborted: either user clicked stop while streaming (pi-agent-core
              // appends the marker naturally inside `handleRunFailure`), or
              // user clicked stop while retry was rebuilding (the background's
              // `handleRebuildAbort` appends the same shape manually). One
              // rendering rule covers both paths.
              const isAborted = assistantMsg.stopReason === 'aborted';

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

              // Meta row: show only on the assistant message that *closes*
              // the turn (stopReason !== 'toolUse'), so multi-tool-round
              // turns get one consolidated meta at the very end instead of
              // one per intermediate model call. The closing message is
              // also the only one whose timing represents the whole turn.
              const turnEnded = !isLast || !isAgentRunning;
              const isTurnClosing =
                turnEnded && assistantMsg.stopReason !== 'toolUse';
              const plainText = getAssistantText(assistantMsg).trim();
              const copyText = isTurnClosing && plainText.length > 0 ? plainText : undefined;

              // Aggregate usage across all assistant messages of this turn
              // (walk back to the most recent user message). Each tool round
              // is its own LLM call with its own usage; users want the sum.
              let meta: Parameters<typeof AgentMessage>[0]['meta'];
              if (isTurnClosing) {
                let inputTokens = 0;
                let outputTokens = 0;
                let cacheReadTokens = 0;
                let cacheWriteTokens = 0;
                for (let i = idx; i >= 0; i--) {
                  const m = messages[i];
                  if (!('role' in m)) continue;
                  if (m.role === 'user') break;
                  if (m.role === 'assistant') {
                    const am = m as AssistantMessage;
                    inputTokens += am.usage?.input ?? 0;
                    outputTokens += am.usage?.output ?? 0;
                    cacheReadTokens += am.usage?.cacheRead ?? 0;
                    cacheWriteTokens += am.usage?.cacheWrite ?? 0;
                  }
                }
                meta = {
                  modelLabel: assistantMsg.model,
                  inputTokens: inputTokens || undefined,
                  outputTokens: outputTokens || undefined,
                  cacheReadTokens: cacheReadTokens || undefined,
                  cacheWriteTokens: cacheWriteTokens || undefined,
                };
              }

              // Retry button: only on the very last message in the timeline,
              // only when the turn has actually closed (no pending tool round),
              // and only when the agent is idle (no overlapping run).
              const canRetry = isLast && isTurnClosing && !isAgentRunning;
              const onRetry = canRetry ? retry : undefined;

              return (
                <AgentMessage
                  key={`asst-${idx}`}
                  isStreaming={isStreaming}
                  showHeader={showHeader}
                  meta={meta}
                  copyText={copyText}
                  onRetry={onRetry}
                >
                  {thinkingBlocks.map((block, i) => (
                    <ThinkingBlock key={`t-${idx}-${i}`} content={block.thinking} isLive={isStreaming} />
                  ))}
                  {text && <AgentTextBlock content={text} />}
                  {isError && (
                    <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2 mt-2 whitespace-pre-wrap break-all">
                      {assistantMsg.errorMessage ?? t('chat.session.modelError')}
                    </div>
                  )}
                  {isAborted && (
                    <div className="text-xs text-muted-foreground/80 italic mt-2">
                      {t('chat.session.cancelled')}
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

                    // MCP App branch: if the tool result carries a UI
                    // resource reference (set by `createMCPAgentTool`
                    // when the original tool declared `_meta.ui.resourceUri`),
                    // swap to ToolCardWithUI for inline iframe render.
                    // While the result is still in-flight, fall through
                    // to ToolCard so the spinner shows — switching only
                    // once we have something to feed the iframe.
                    //
                    // Use a structural guard rather than a cast: `details`
                    // is `any` (per `ToolResultMessage<TDetails = any>`),
                    // so a truthy check would let a corrupted IDB row or
                    // an off-spec server's bogus payload reach the iframe
                    // and produce a vague fetch failure downstream.
                    if (toolResult?.details && isMcpAppResult(toolResult.details)) {
                      // Synthesise the SDK's `CallToolResult` wire shape
                      // from the existing message fields — we deliberately
                      // don't persist a second copy on `details.mcpApp`,
                      // see JSDoc on `MCPAppDetails` for the storage
                      // motivation.
                      const synthesizedToolResult: CallToolResult = {
                        content: toolResult.content as CallToolResult['content'],
                        ...(toolResult.details.structured !== undefined
                          ? { structuredContent: toolResult.details.structured as Record<string, unknown> }
                          : {}),
                        isError: toolResult.isError,
                      };
                      return (
                        <ToolCardWithUI
                          key={`tool-${tc.id}`}
                          label={getToolLabel(tc.name, tc.arguments)}
                          // Real MCP tool name (e.g. `create_diagram`), not
                          // the agent-runtime slug `mcp__drawio__create_diagram`.
                          // The slug is sanitized for provider name limits;
                          // the View receives this via `ui/notifications/tool-*`
                          // and SEP-1865 expects the real name so apps that
                          // dispatch on `tool` recognise it.
                          toolName={toolResult.details.tool}
                          serverId={toolResult.details.server.id}
                          mcpApp={toolResult.details.mcpApp}
                          toolResult={synthesizedToolResult}
                        />
                      );
                    }

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
                <p className="text-sm text-muted-foreground">{t('chat.composer.needModel')}</p>
              ) : (
                <p className="text-sm text-muted-foreground">{t('chat.session.welcomeReady')}</p>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

        {!isAtBottom && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="secondary"
                size="icon"
                aria-label={t('chat.session.scrollToBottom')}
                onClick={() => scrollToBottom({ force: true })}
                className="absolute bottom-3 right-3 size-8 rounded-full shadow-md border border-border/60 bg-background/90 backdrop-blur hover:bg-background"
              >
                <ArrowDown className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('chat.session.scrollToBottom')}</TooltipContent>
          </Tooltip>
        )}
      </div>

      <ChatInput
        onSend={handleSend}
        onCancel={cancel}
        isAgentRunning={effectiveRunning}
        onOpenSettings={onOpenSettings}
        userHistory={userHistory}
        sessionId={isNewChat ? activeSessionId : routeSessionId ?? null}
      />
    </>
  );
}

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowDown } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ChatInput, type ChatInputHandle } from '@/components/chat/ChatInput';
import { WelcomeScreen } from '@/components/chat/WelcomeScreen';
import {
  UserMessageBubble,
  AgentMessage,
  AgentTextBlock,
  ThinkingBlock,
  CompactionDivider,
  CompactionPlaceholder,
  PermissionRequestBlock,
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
} from '@/lib/agent/message-helpers';
import { getToolLabel } from '@/lib/tools/labels';
import { uiToolRegistry } from '@/lib/tools/ui-registry';
import { isCompactionSummary } from '@/lib/agent/compaction';
import { isPermissionRequest } from '@/lib/agent/tool-permissions';
import { useBackgroundAgent } from '@/hooks/useBackgroundAgent';
import { useStickToBottom } from '@/hooks/useStickToBottom';
import { useStorageItem } from '@/hooks/useStorageItem';
import { lastSelectedModel, lastSelectedThinkingLevel as thinkingLevelStorage, providerCredentials, customProviders, type ModelIdentity, type ThinkingLevel } from '@/lib/persistence/storage';
import { hasUsableModel } from '@/lib/providers/usable-models';
import type { Attachment } from '@/lib/agent/attachments';
import type { SessionSnapshot } from '@/lib/ipc/protocol';
import { t } from '@/lib/i18n';

// ─── ChatPage ───

export function ChatPage({ onOpenSettings, onTitleChange }: { onOpenSettings?: () => void; onTitleChange?: (title: string) => void }) {
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const isNewChat = !routeSessionId || routeSessionId === 'new';
  const navigate = useNavigate();

  // 本窗口 / 本对话「当前选中的模型 / 思考档」本地草稿。发送 / 重试时随消息带出作
  // turn；新对话从全局种子 seed、已有会话从会话行（onSessionLoaded）seed。不直连全局
  // storage，以免一个窗口切模型影响另一个。
  const [turnModel, setTurnModel] = useState<ModelIdentity | null>(null);
  const [turnThinking, setTurnThinking] = useState<ThinkingLevel>('medium');

  // 是否存在至少一个可选模型（= 用户至少配好一个 provider）。驱动欢迎页空状态文案：
  // 有 → 显示示例（引导去底部选模型）；无 → 引导去设置。响应式订阅 provider 凭据 /
  // 自定义 provider——用户刚在设置里配好就实时反映，这正是 watch 的正当用途。
  const [creds] = useStorageItem(providerCredentials, {});
  const [customs] = useStorageItem(customProviders, []);
  const canStartChat = useMemo(() => hasUsableModel(creds, customs), [creds, customs]);

  // 新对话：seed 自全局「新对话默认种子」（= 用户上次切到的）。全局种子只是持久化
  // 偏好、不驱动任何实时 UI（真正响应式的是上面的 turn 草稿），故这里直接异步读一次
  // 即可，不用 useStorageItem 订阅——避免 watch 回调的多余重渲染 + 自写触发的 seed
  // 空跑 + 双切闪烁竞态。代价：另一个窗口在新对话里切模型不会实时同步到本窗口的未
  // 动过新对话（WYSIWYG，反而更可预期），种子仍正确写入不丢。
  useEffect(() => {
    if (!isNewChat) return;
    let mounted = true;
    Promise.all([lastSelectedModel.getValue(), thinkingLevelStorage.getValue()]).then(([m, l]) => {
      if (!mounted) return;
      setTurnModel(m);
      setTurnThinking(l ?? 'medium');
    });
    return () => { mounted = false; };
  }, [isNewChat]);

  // 把会话行存的选择 seed 进本地 turn 草稿。provider / model 为空（旧会话 / 旧备份）
  // 时置 null，让发送门禁拦下来提示用户重选。onSessionLoaded（首次加载）与
  // onSessionSettings（重订阅活 agent 走 session_state）共用同一逻辑。
  const seedTurnFromSession = useCallback((provider?: string, model?: string, thinkingLevel?: string) => {
    setTurnModel(provider && model ? { provider, modelId: model } : null);
    setTurnThinking((thinkingLevel as ThinkingLevel) || 'medium');
  }, []);

  // 切模型 / 思考档：更新本地草稿 + 回写全局种子（供下一个新对话用，fire-and-forget）。
  // 不在此落库到会话行——那是发送 / 重试时由 turn 随消息带给后台做的（carry-on-message）。
  const handleModelChange = useCallback((m: ModelIdentity) => {
    setTurnModel(m);
    void lastSelectedModel.setValue(m);
  }, []);
  const handleThinkingChange = useCallback((l: ThinkingLevel) => {
    setTurnThinking(l);
    void thinkingLevelStorage.setValue(l);
  }, []);

  // 句柄：欢迎页示例卡片通过它把 prompt 填入输入框。
  const inputRef = useRef<ChatInputHandle>(null);

  // ─── Agent port (all agent/session logic via background) ───
  const {
    state,
    pendingTools,
    pendingPermissions,
    send,
    cancel,
    retry,
    editMessage,
    switchBranch,
    subscribe: portSubscribe,
    unsubscribe: portUnsubscribe,
    resolveTool,
    resolvePermission,
  } = useBackgroundAgent({
    onSessionCreated: useCallback((sessionId: string, title: string) => {
      onTitleChange?.(title);
      navigate(`/chat/${sessionId}`, { replace: true });
    }, [navigate, onTitleChange]),
    onSessionLoaded: useCallback((session: SessionSnapshot | null) => {
      if (!session) {
        navigate('/chat/new', { replace: true });
        return;
      }
      // 已有会话：本地草稿 seed 自会话行自己存的选择（而非全局）。模型 / provider
      // 为空（旧会话 / 旧备份）时置 null，让发送门禄拦下来提示用户重选。
      seedTurnFromSession(session.provider, session.model, session.thinkingLevel);
    }, [navigate, seedTurnFromSession]),
    // 重新订阅一个仍有活 agent 的会话时，后台走 session_state（不带完整会话行），
    // 由它单独回传该会话的模型 / 思考档来 seed——与 onSessionLoaded 同样的逻辑。
    onSessionSettings: useCallback((provider: string, model: string, thinkingLevel: string) => {
      seedTurnFromSession(provider, model, thinkingLevel);
    }, [seedTurnFromSession]),
  });

  const { messages, branchInfo, isAgentRunning, isCompacting, sessionId: activeSessionId, sessionTitle, lastError } = state;

  // Mirror activeSessionId into a ref so the subscribe-effect can read the
  // latest value WITHOUT re-running when activeSessionId changes. Putting
  // activeSessionId in the effect's deps would cause an extra run between
  // session_created (which sets state.sessionId) and navigate (which sets
  // routeSessionId) — at that point isNewChat is still true, so the effect
  // would hit portUnsubscribe() and wipe the optimistic user message.
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;

  // When an interactive tool (e.g. ask_user) OR a permission prompt is pending,
  // the agent is blocked waiting for user input — treat as "not running" so the
  // composer stays usable. For permissions this is deliberate: sending a message
  // while a prompt is pending is the implicit "dismiss" (non-grant) path, handled
  // by steer + bridge cancel in the background.
  const effectiveRunning = isAgentRunning && pendingTools.size === 0 && pendingPermissions.size === 0;

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
      // 切换到已有会话但其会话行尚未加载完（sessionLoading）时拒绝派发：此刻
      // turnModel 还是上一个会话的本地草稿，若此时发送会把旧模型携带给新会话、
      // 污染新会话行。等 onSessionLoaded 把 turnModel 重新 seed 后再放行。
      if (!isNewChat && routeSessionId !== activeSessionId) {
        return { status: 'notDispatched', reason: 'unavailable' } as const;
      }
      const result = await send(text, attachments, expectedSessionId, {
        model: turnModel ?? undefined,
        thinkingLevel: turnThinking,
      });
      if (result.status === 'dispatched') {
        scrollToBottom({ force: true });
      }
      return result;
    },
    [scrollToBottom, send, turnModel, turnThinking, isNewChat, routeSessionId, activeSessionId],
  );

  // 重试同样携带本轮选中的模型 / 思考档，支持「换个模型再重试」。`entryId` 指定
  // 要重试的那一轮的 user 消息（历史任意轮）；缺省 = 最后一轮。
  const handleRetry = useCallback((entryId?: string) => {
    retry({ model: turnModel ?? undefined, thinkingLevel: turnThinking }, entryId);
  }, [retry, turnModel, turnThinking]);

  // 分支切换：目标是分支点上的兄弟 entry（由消息操作区传入）。
  const handleSwitchBranch = useCallback((targetEntryId: string) => {
    switchBranch(targetEntryId);
  }, [switchBranch]);

  // 编辑已发送的 user 消息（issue #44）：以新文案从该消息重新生成，同样携带本轮
  // 选中的模型 / 思考档。发送后强制回底，与 handleSend 一致。
  const handleEdit = useCallback((entryId: string, text: string) => {
    editMessage(entryId, text, { model: turnModel ?? undefined, thinkingLevel: turnThinking });
    scrollToBottom({ force: true });
  }, [editMessage, turnModel, turnThinking, scrollToBottom]);

  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  // 压缩期间隐藏思考占位符，改由专门的压缩状态条提示，避免两个动效重叠。
  const showWaitingPlaceholder = effectiveRunning && !isCompacting && lastMsg && lastMsg.role === 'user';

  // History of user-typed prompts in this session, oldest first; consumed by
  // ChatInput's ↑/↓ navigation. Strips the <user-request> wrapper added by
  // composeUserMessage so what comes back is exactly what the user typed.
  const userHistory = useMemo(
    () => messages
      .filter((m): m is UserMessage => m.role === 'user')
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
            if (isCompactionSummary(msg)) {
              return (
                <CompactionDivider key={`compact-${idx}`} />
              );
            }

            if (isPermissionRequest(msg)) {
              // isLive = 后台有活 agent 正等这次授权（按 toolCallId 匹配）。
              // 查不到 → 失效态（如 SW 重启后），卡片置灰且按钮禁用。
              const isLive = pendingPermissions.has(msg.toolCallId);
              return (
                <PermissionRequestBlock
                  key={`perm-${msg.toolCallId}`}
                  title={msg.title}
                  permissions={msg.permissions}
                  decision={msg.decision}
                  isLive={isLive}
                  onResolve={isLive ? (decision) => resolvePermission(msg.toolCallId, decision) : undefined}
                />
              );
            }

            if (msg.role === 'user') {
              // 编辑入口：消息已落树（有 entryId）且 agent 空闲时才提供——
              // 未落树的乐观消息无处可回卷，运行中编辑会与在途轮冲突。
              const canEdit = msg.entryId !== undefined && !isAgentRunning;
              const entryId = msg.entryId;
              const branch = entryId ? branchInfo[entryId] : undefined;
              return (
                <UserMessageBubble
                  key={`user-${entryId ?? idx}`}
                  msg={msg}
                  onEdit={canEdit && entryId ? (text) => handleEdit(entryId, text) : undefined}
                  branch={branch
                    ? {
                      index: branch.index,
                      count: branch.count,
                      disabled: isAgentRunning,
                      onPrev: branch.index > 0
                        ? () => handleSwitchBranch(branch.siblings[branch.index - 1])
                        : undefined,
                      onNext: branch.index < branch.count - 1
                        ? () => handleSwitchBranch(branch.siblings[branch.index + 1])
                        : undefined,
                    }
                    : undefined}
                />
              );
            }

            if (msg.role === 'assistant') {
              const assistantMsg = msg as AssistantMessage;
              const thinkingBlocks = getThinkingBlocks(assistantMsg);
              const text = getAssistantText(assistantMsg);
              const toolCalls = getToolCalls(assistantMsg);
              const isLast = idx === messages.length - 1;
              // 压缩期间 session_state 仍带 isRunning:true，但本轮还没真正开始流式输出，
              // 须插 !isCompacting 防止在已写完的上一条 assistant 末尾点亮流式光标。
              const isStreaming = isLast && effectiveRunning && !isCompacting;
              const isError = assistantMsg.stopReason === 'error';
              // Aborted: either user clicked stop while streaming (pi-agent-core
              // appends the marker naturally inside `handleRunFailure`), or
              // user clicked stop while a retry was preparing (the background's
              // `commitRetryCancel` appends the same shape manually). One
              // rendering rule covers both paths.
              const isAborted = assistantMsg.stopReason === 'aborted';

              // Show header only for the first assistant message in a consecutive group
              let showHeader = true;
              for (let i = idx - 1; i >= 0; i--) {
                const prev = messages[i];
                if (prev.role === 'toolResult') {
                  const tr = prev as ToolResultMessage;
                  const info = uiToolRegistry.get(tr.toolName);
                  if (info?.renderResultAsUserBubble && !tr.details?.cancelled) break;
                  continue;
                }
                // 权限卡片是这一轮中间插入的授权环节，对头折叠「透明」：穿透它
                // 继续往前看，避免把本来连续的 assistant 块劈成两轮、长出重复的头。
                if (isPermissionRequest(prev)) continue;
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

              // Retry：任意已闭合的轮次都可重试（树化后旧回复保留为分支，不再
              // 破坏性截断）。最后一轮沿用旧语义（后台自寻最后一条 user）；历史
              // 轮次需要定位该轮起点的 user 消息 entryId——向前找最近的 user，
              // 找不到（该轮由交互式工具结果驱动等）则不提供入口。
              let turnUserEntryId: string | undefined;
              for (let i = idx - 1; i >= 0; i--) {
                const m = messages[i];
                if (m.role === 'user') {
                  turnUserEntryId = m.entryId;
                  break;
                }
                if (
                  m.role === 'toolResult' &&
                  uiToolRegistry.get((m as ToolResultMessage).toolName)?.renderResultAsUserBubble &&
                  !(m as ToolResultMessage).details?.cancelled
                ) {
                  // 该轮由交互式工具结果开启，无对应 user 消息（被取消的结果对轮
                  // 边界「透明」，与 showHeader 的扫描口径一致）
                  break;
                }
              }
              const canRetry =
                isTurnClosing && !isAgentRunning && (isLast || turnUserEntryId !== undefined);
              const onRetry = canRetry
                ? () => handleRetry(isLast ? undefined : turnUserEntryId)
                : undefined;
              const branch = msg.entryId ? branchInfo[msg.entryId] : undefined;

              return (
                <AgentMessage
                  key={`asst-${msg.entryId ?? idx}`}
                  isStreaming={isStreaming}
                  showHeader={showHeader}
                  meta={meta}
                  copyText={copyText}
                  onRetry={onRetry}
                  branch={branch
                    ? {
                      index: branch.index,
                      count: branch.count,
                      disabled: isAgentRunning,
                      onPrev: branch.index > 0
                        ? () => handleSwitchBranch(branch.siblings[branch.index - 1])
                        : undefined,
                      onNext: branch.index < branch.count - 1
                        ? () => handleSwitchBranch(branch.siblings[branch.index + 1])
                        : undefined,
                    }
                    : undefined}
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
                      : (isAborted ? 'cancelled' : 'running');
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
                  {/* Cancelled marker sits after the tool cards, matching the text -> tool card -> cancelled timeline */}
                  {isAborted && (
                    <div className="text-xs text-muted-foreground/80 italic mt-2">
                      {t('chat.session.cancelled')}
                    </div>
                  )}
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

          {/* Compaction in-progress placeholder: normal Cebian Agent shell + grey italic status */}
          {isCompacting && <CompactionPlaceholder />}

          {/* Error display */}
          {lastError && !isAgentRunning && (
            <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
              {lastError}
            </div>
          )}

          {!sessionLoading && messages.length === 0 && !isAgentRunning && (
            <WelcomeScreen
              hasModel={canStartChat}
              onPickExample={(prompt) => inputRef.current?.fill(prompt)}
              onOpenSettings={() => onOpenSettings?.()}
            />
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
        ref={inputRef}
        onSend={handleSend}
        onCancel={cancel}
        isAgentRunning={effectiveRunning}
        onOpenSettings={onOpenSettings}
        userHistory={userHistory}
        sessionId={isNewChat ? activeSessionId : routeSessionId ?? null}
        model={turnModel}
        thinkingLevel={turnThinking}
        onModelChange={handleModelChange}
        onThinkingChange={handleThinkingChange}
      />
    </>
  );
}

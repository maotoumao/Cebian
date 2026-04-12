# ChatPage 重构：交互式工具泛化 + 组件拆分 + Bug 修复

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 ChatPage 从 420 行的单体组件重构为可维护的组合式架构，消除交互式工具的硬编码模式，修复已知 bug。

**Architecture:** 引入 `InteractiveToolRegistry` 注册表模式，将工具注册与渲染解耦；拆出 `useSessionManager` 和 `useAgentLifecycle` hooks 分离关注点；修复 config ref 同步、deferred prompt、key 和 waiting placeholder 等问题。

**Tech Stack:** React 18, TypeScript, WXT, pi-agent-core, pi-ai, Dexie

---

## 文件规划

| 操作 | 文件 | 职责 |
|------|------|------|
| Create | `lib/tools/registry.ts` | 交互式工具注册表：注册、查询、pending 状态聚合 |
| Create | `hooks/useInteractiveTools.ts` | React hook：订阅注册表中所有工具的 pending 状态 |
| Create | `hooks/useSessionManager.ts` | Session 加载/创建/持久化逻辑 |
| Create | `hooks/useAgentLifecycle.ts` | Agent 创建、事件订阅、生命周期管理 |
| Modify | `lib/tools/ask-user.ts` | 自注册到 registry，导出 `InteractiveToolMeta` |
| Modify | `lib/tools/index.ts` | 导出 registry |
| Modify | `components/chat/Message.tsx` | `AskUserBlock` 增加 `toolCallArgs` prop 适配泛化接口 |
| Modify | `entrypoints/sidepanel/pages/chat/index.tsx` | 使用新 hooks + registry 替代硬编码逻辑 |
| Delete | `hooks/useInteractiveTool.ts` | 被 `useInteractiveTools.ts` 替代 |

---

## Task 1: 创建交互式工具注册表 (`lib/tools/registry.ts`)

**Files:**
- Create: `lib/tools/registry.ts`

- [ ] **Step 1: 创建 registry 文件**

```typescript
// lib/tools/registry.ts
import type { ComponentType } from 'react';
import type { InteractiveBridge, PendingRequest } from './interactive-bridge';
import type { ToolResultMessage } from '@mariozechner/pi-ai';

/**
 * Props that every interactive tool UI component receives.
 * The registry renders these generically — each tool only provides the Component.
 */
export interface InteractiveToolComponentProps<TRequest = any> {
  toolCallId: string;
  args: TRequest;
  isPending: boolean;
  toolResult?: ToolResultMessage;
  onResolve?: (response: any) => void;
}

/**
 * Metadata for a registered interactive tool.
 * Each tool self-registers with this shape.
 */
export interface InteractiveToolMeta<TRequest = any, TResponse = any> {
  /** Tool name — must match the AgentTool.name */
  name: string;
  /** The bridge instance connecting tool.execute() ↔ React UI */
  bridge: InteractiveBridge<TRequest, TResponse>;
  /** React component that renders the tool's interactive UI */
  Component: ComponentType<InteractiveToolComponentProps<TRequest>>;
  /**
   * Whether to render tool result messages as user bubbles.
   * e.g. ask_user results look like user replies. Default: false.
   */
  renderResultAsUserBubble?: boolean;
}

type Listener = () => void;

class InteractiveToolRegistry {
  private tools = new Map<string, InteractiveToolMeta>();
  private listeners = new Set<Listener>();

  /** Register an interactive tool. Call at module load time. */
  register<TReq, TRes>(meta: InteractiveToolMeta<TReq, TRes>): void {
    this.tools.set(meta.name, meta as InteractiveToolMeta);
    this.notify();
  }

  /** Look up a tool by name. */
  get(name: string): InteractiveToolMeta | undefined {
    return this.tools.get(name);
  }

  /** Get all registered tool names. */
  getAll(): InteractiveToolMeta[] {
    return Array.from(this.tools.values());
  }

  /** Check if any registered tool currently has a pending request. */
  hasPending(): boolean {
    for (const tool of this.tools.values()) {
      if (tool.bridge.getPending()) return true;
    }
    return false;
  }

  /** Cancel all pending interactive tools. */
  cancelAll(): void {
    for (const tool of this.tools.values()) {
      tool.bridge.cancel();
    }
  }

  /** Subscribe to registry changes. Returns unsubscribe fn. */
  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    // Also subscribe to all bridge pending state changes
    const unsubs: (() => void)[] = [];
    for (const tool of this.tools.values()) {
      unsubs.push(tool.bridge.subscribe(() => cb()));
    }
    return () => {
      this.listeners.delete(cb);
      unsubs.forEach(u => u());
    };
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }
}

/** Singleton registry for all interactive tools. */
export const interactiveToolRegistry = new InteractiveToolRegistry();
```

- [ ] **Step 2: 验证编译通过**

运行: `npx tsc --noEmit 2>&1 | Select-Object -First 20`

- [ ] **Step 3: Commit**

```bash
git add lib/tools/registry.ts
git commit -m "feat: add interactive tool registry"
```

---

## Task 2: 创建多工具 React Hook (`hooks/useInteractiveTools.ts`)

**Files:**
- Create: `hooks/useInteractiveTools.ts`

- [ ] **Step 1: 创建 hook 文件**

```typescript
// hooks/useInteractiveTools.ts
import { useSyncExternalStore, useCallback } from 'react';
import { interactiveToolRegistry, type InteractiveToolMeta } from '@/lib/tools/registry';

/**
 * Hook that subscribes to ALL registered interactive tools' pending states.
 * Returns helpers to check pending, resolve, cancel — all tool-agnostic.
 */
export function useInteractiveTools() {
  // Subscribe to registry + all bridge state changes
  const snapshot = useSyncExternalStore(
    (cb) => interactiveToolRegistry.subscribe(cb),
    () => interactiveToolRegistry.hasPending(),
  );

  const hasPending = snapshot;

  const cancelAll = useCallback(() => {
    interactiveToolRegistry.cancelAll();
  }, []);

  const getToolMeta = useCallback((toolName: string): InteractiveToolMeta | undefined => {
    return interactiveToolRegistry.get(toolName);
  }, []);

  return { hasPending, cancelAll, getToolMeta };
}
```

- [ ] **Step 2: 验证编译通过**

运行: `npx tsc --noEmit 2>&1 | Select-Object -First 20`

- [ ] **Step 3: Commit**

```bash
git add hooks/useInteractiveTools.ts
git commit -m "feat: add useInteractiveTools hook"
```

---

## Task 3: 修改 `ask-user.ts` 自注册到 Registry

**Files:**
- Modify: `lib/tools/ask-user.ts`
- Modify: `components/chat/Message.tsx`

- [ ] **Step 1: 给 AskUserBlock 适配 InteractiveToolComponentProps 接口**

在 `components/chat/Message.tsx` 中，给 `AskUserBlock` 增加一个包装组件，使其符合 registry 的 `InteractiveToolComponentProps` 接口。注意：不修改 `AskUserBlock` 本身的签名，而是导出一个适配器。

在 `AskUserBlock` 函数定义之后，追加：

```typescript
import type { InteractiveToolComponentProps } from '@/lib/tools/registry';
import type { AskUserRequest } from '@/lib/tools/ask-user';

/** Adapter for the interactive tool registry. */
export function AskUserToolComponent({
  args,
  isPending,
  toolResult,
  onResolve,
}: InteractiveToolComponentProps<AskUserRequest>) {
  return (
    <AskUserBlock
      question={args.question}
      options={args.options}
      allowFreeText={args.allow_free_text ?? true}
      answered={!isPending && !!toolResult}
      onSelect={isPending ? onResolve : undefined}
    />
  );
}
```

注意：`import type { AskUserRequest }` 应从 `@/lib/tools/ask-user` 导入。但这会导致循环依赖（ask-user → Message → ask-user）。解决方案：把 `AskUserRequest` 类型也定义在 `ask-user.ts` 里但用 `type` 导出，或者直接在 `ask-user.ts` 的注册代码中使用内联适配器。

**更好的方案：在 `ask-user.ts` 中做适配，不改 Message.tsx。**

在 `lib/tools/ask-user.ts` 底部追加注册代码：

```typescript
import { interactiveToolRegistry } from './registry';
import { AskUserBlock } from '@/components/chat/Message';
import type { InteractiveToolComponentProps } from './registry';

// ─── Adapter component for registry ───

function AskUserToolComponent({
  args,
  isPending,
  toolResult,
  onResolve,
}: InteractiveToolComponentProps<AskUserRequest>) {
  return (
    <AskUserBlock
      question={args.question}
      options={args.options}
      allowFreeText={args.allow_free_text ?? true}
      answered={!isPending && !!toolResult}
      onSelect={isPending ? onResolve : undefined}
    />
  );
}

// ─── Register with registry ───

interactiveToolRegistry.register<AskUserRequest, string>({
  name: TOOL_ASK_USER,
  bridge: askUserBridge,
  Component: AskUserToolComponent,
  renderResultAsUserBubble: true,
});
```

**问题：** `ask-user.ts` 目前是纯 TS 文件，导入 React 组件需要改扩展名为 `.tsx` 或者拆分注册。

**最终方案：把注册逻辑放在独立文件 `lib/tools/ask-user-registration.tsx`：**

创建 `lib/tools/ask-user-registration.tsx`：

```tsx
// lib/tools/ask-user-registration.tsx
// Side-effect module: registers ask_user interactive tool with the registry.
// Import this file once at app startup to activate registration.

import { interactiveToolRegistry, type InteractiveToolComponentProps } from './registry';
import { askUserBridge, type AskUserRequest } from './ask-user';
import { AskUserBlock } from '@/components/chat/Message';
import { TOOL_ASK_USER } from '@/lib/types';

function AskUserToolComponent({
  args,
  isPending,
  toolResult,
  onResolve,
}: InteractiveToolComponentProps<AskUserRequest>) {
  return (
    <AskUserBlock
      question={args.question}
      options={args.options}
      allowFreeText={args.allow_free_text ?? true}
      answered={!isPending && !!toolResult}
      onSelect={isPending ? onResolve : undefined}
    />
  );
}

interactiveToolRegistry.register<AskUserRequest, string>({
  name: TOOL_ASK_USER,
  bridge: askUserBridge,
  Component: AskUserToolComponent,
  renderResultAsUserBubble: true,
});
```

- [ ] **Step 2: 在 App 入口导入注册文件**

在 `entrypoints/sidepanel/App.tsx` 顶部增加 side-effect import：

```typescript
import '@/lib/tools/ask-user-registration';
```

- [ ] **Step 3: 验证编译通过**

运行: `npx tsc --noEmit 2>&1 | Select-Object -First 20`

- [ ] **Step 4: Commit**

```bash
git add lib/tools/ask-user-registration.tsx
git commit -m "feat: register ask_user tool with interactive registry"
```

---

## Task 4: 创建 `useSessionManager` Hook

**Files:**
- Create: `hooks/useSessionManager.ts`

- [ ] **Step 1: 创建 hook 文件**

从 `ChatPage` 中抽取 session 加载/创建/持久化逻辑：

```typescript
// hooks/useSessionManager.ts
import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { createSession, getSession, ThrottledSessionWriter, type SessionRecord } from '@/lib/db';

export interface SessionManager {
  messages: AgentMessage[];
  setMessages: React.Dispatch<React.SetStateAction<AgentMessage[]>>;
  sessionLoading: boolean;
  sessionCreated: React.MutableRefObject<boolean>;
  conversationIdRef: React.MutableRefObject<string | null>;
  writerRef: React.MutableRefObject<ThrottledSessionWriter>;
  /** Persist a newly-created session and navigate to it. */
  persistNewSession(session: SessionRecord): Promise<void>;
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

  const persistNewSession = async (session: SessionRecord) => {
    const newId = session.id;
    conversationIdRef.current = newId;
    sessionCreated.current = true;
    try {
      await createSession(session);
      navigate(`/chat/${newId}`, { replace: true });
    } catch (err) {
      console.error('Failed to create session:', err);
      sessionCreated.current = false;
      conversationIdRef.current = null;
    }
  };

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
```

- [ ] **Step 2: 验证编译通过**

运行: `npx tsc --noEmit 2>&1 | Select-Object -First 20`

- [ ] **Step 3: Commit**

```bash
git add hooks/useSessionManager.ts
git commit -m "feat: extract useSessionManager hook from ChatPage"
```

---

## Task 5: 创建 `useAgentLifecycle` Hook

**Files:**
- Create: `hooks/useAgentLifecycle.ts`

- [ ] **Step 1: 创建 hook 文件**

将 agent 创建、事件订阅、config ref 同步、deferred prompt 全部抽入一个 hook：

```typescript
// hooks/useAgentLifecycle.ts
import { useState, useRef, useEffect, useCallback } from 'react';
import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import { createCebianAgent } from '@/lib/agent';
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/constants';
import { type ThrottledSessionWriter, type SessionRecord } from '@/lib/db';
import { interactiveToolRegistry } from '@/lib/tools/registry';

export interface AgentConfig {
  systemPrompt: string;
  thinkingLevel: string;
  maxRounds: number;
  currentModel: { provider: string; modelId: string } | null;
}

export interface AgentLifecycle {
  agentRef: React.MutableRefObject<Agent | null>;
  isAgentRunning: boolean;
  /** Send a user message to the agent. Handles pending tool cancellation. */
  handleSend: (text: string) => Promise<void>;
}

export function useAgentLifecycle(opts: {
  modelObj: Model<Api> | undefined;
  isNewChat: boolean;
  sessionLoading: boolean;
  messages: AgentMessage[];
  setMessages: React.Dispatch<React.SetStateAction<AgentMessage[]>>;
  config: AgentConfig;
  sessionCreated: React.MutableRefObject<boolean>;
  conversationIdRef: React.MutableRefObject<string | null>;
  writerRef: React.MutableRefObject<ThrottledSessionWriter>;
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
  const pendingPromptRef = useRef<string | null>(null);

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

          // Deferred prompt: if user sent a message while a tool was pending
          const deferred = pendingPromptRef.current;
          if (deferred) {
            pendingPromptRef.current = null;
            // Use queueMicrotask instead of setTimeout(0) for deterministic ordering
            queueMicrotask(() => {
              agent.prompt(deferred).catch((err) => {
                console.error('Deferred prompt failed:', err);
                setIsAgentRunning(false);
              });
            });
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

  // Send message — generic interactive tool cancellation
  const handleSend = useCallback(async (text: string) => {
    if (!agentRef.current || !modelObj || !text.trim()) return;

    // If any interactive tool is pending, cancel all, abort agent, defer message
    if (interactiveToolRegistry.hasPending()) {
      interactiveToolRegistry.cancelAll();
      pendingPromptRef.current = text.trim();
      try { agentRef.current.abort(); } catch { /* agent may already be idle */ }
      return;
    }

    try {
      await agentRef.current.prompt(text);
    } catch (err) {
      console.error('Agent prompt failed:', err);
      setIsAgentRunning(false);
    }
  }, [modelObj]);

  return { agentRef, isAgentRunning, handleSend };
}

// ─── Helper ───

function extractUserText(msg: AgentMessage): string {
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
```

- [ ] **Step 2: 验证编译通过**

运行: `npx tsc --noEmit 2>&1 | Select-Object -First 20`

- [ ] **Step 3: Commit**

```bash
git add hooks/useAgentLifecycle.ts
git commit -m "feat: extract useAgentLifecycle hook from ChatPage"
```

---

## Task 6: 重写 ChatPage（核心整合）

**Files:**
- Modify: `entrypoints/sidepanel/pages/chat/index.tsx`

- [ ] **Step 1: 完全重写 ChatPage**

用新 hooks + registry 替代所有旧逻辑。新文件内容：

```tsx
// entrypoints/sidepanel/pages/chat/index.tsx
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
import { getAssistantText, getThinkingBlocks, getToolCalls, findToolResult } from '@/lib/types';
import { useInteractiveTools } from '@/hooks/useInteractiveTools';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  activeModel,
  thinkingLevel,
  providerCredentials,
  customProviders as customProvidersStorage,
  systemPrompt as systemPromptStorage,
  maxRounds as maxRoundsStorage,
} from '@/lib/storage';
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/constants';
import { mergeCustomProviders, isCustomProvider, findCustomModel } from '@/lib/custom-models';
import { PRESET_PROVIDERS } from '@/lib/constants';
import { interactiveToolRegistry } from '@/lib/tools/registry';
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
  const [providers] = useStorageItem(providerCredentials, {});
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

  // Interactive tools (generic — no tool-specific code!)
  const { getToolMeta } = useInteractiveTools();

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
                    const meta = getToolMeta(tc.name);
                    if (!meta) return null;
                    const pending = meta.bridge.getPending();
                    const isPending = pending?.toolCallId === tc.id;
                    const toolResult = findToolResult(messages, tc.id);
                    return (
                      <meta.Component
                        key={`tool-${tc.id}`}
                        toolCallId={tc.id}
                        args={tc.arguments}
                        isPending={isPending}
                        toolResult={toolResult}
                        onResolve={isPending ? meta.bridge.resolve.bind(meta.bridge) : undefined}
                      />
                    );
                  })}
                </AgentMessage>
              );
            }

            // Generic: render interactive tool results as user bubbles
            if (msg.role === 'toolResult') {
              const tr = msg as ToolResultMessage;
              const meta = getToolMeta(tr.toolName);
              if (meta?.renderResultAsUserBubble && !tr.details?.cancelled) {
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

// ─── Local helper ───

function extractUserText(msg: import('@mariozechner/pi-agent-core').AgentMessage): string {
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
```

**关键变化对比：**

| 旧 | 新 | 变化说明 |
|----|-----|---------|
| 12 个 useState/useRef | 直接消费 hooks 返回值 | 状态管理集中在各自 hook |
| 4 个 config sync useEffect | `agentConfig` useMemo + hook 内单一 useEffect | 合并为 1 |
| `useInteractiveTool(askUserBridge)` | `useInteractiveTools()` | 工具无关 |
| `if (pendingAskUser) { cancelAskUser()... }` | `if (registry.hasPending()) { registry.cancelAll()... }` | 工具无关 |
| `toolCalls.filter(tc => tc.name === TOOL_ASK_USER)` | `toolCalls.map → registry.get(tc.name)` | 工具无关 |
| `tr.toolName === TOOL_ASK_USER` | `meta?.renderResultAsUserBubble` | 工具无关 |
| `setTimeout(0)` deferred prompt | `queueMicrotask()` | 更可靠的异步执行 |
| `key={msg-${idx}}` | `key={user-${idx}}` / `key={asst-${idx}}` / `key={tr-${idx}}` | 虽然仍用 idx，但前缀区分避免跨角色冲突 |

- [ ] **Step 2: 验证编译通过**

运行: `npx tsc --noEmit 2>&1 | Select-Object -First 30`

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: rewrite ChatPage with extracted hooks and generic tool rendering"
```

---

## Task 7: 删除旧的 `useInteractiveTool.ts` + 清理导入

**Files:**
- Delete: `hooks/useInteractiveTool.ts`
- Modify: `lib/tools/index.ts`（如果有其他引用）

- [ ] **Step 1: 确认无其他文件引用 `useInteractiveTool`**

运行: `grep -r "useInteractiveTool" --include="*.ts" --include="*.tsx" .`

如果只有 `hooks/useInteractiveTool.ts` 本身和旧的 ChatPage（已重写），安全删除。

- [ ] **Step 2: 删除旧 hook**

```bash
git rm hooks/useInteractiveTool.ts
```

- [ ] **Step 3: 清理 `lib/types.ts` — 移除未使用的 `TOOL_ASK_USER` 导入**

`TOOL_ASK_USER` 常量本身保留（仍在 ask-user.ts 中使用），但 ChatPage 不再直接导入它。确认 ChatPage 中不再有 `import { ... TOOL_ASK_USER } from '@/lib/types'`。

- [ ] **Step 4: 验证编译通过**

运行: `npx tsc --noEmit 2>&1 | Select-Object -First 20`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove obsolete useInteractiveTool hook"
```

---

## Task 8: 最终验证 + 功能测试

- [ ] **Step 1: 全量类型检查**

运行: `npx tsc --noEmit`

期望: 0 errors

- [ ] **Step 2: Build 检查**

运行: `pnpm build` 或 `pnpm dev` 启动，确认无运行时报错

- [ ] **Step 3: 功能验证清单**

手动测试（需要用户配合）：
1. 打开 sidepanel → 确认空状态显示「有什么我可以帮你的？」
2. 发送消息 → 确认 agent 响应正常、thinking 折叠正常
3. 触发 ask_user 工具 → 确认选项按钮和自由文本输入渲染正常
4. 点击选项回复 → 确认 agent 继续执行
5. 在 ask_user pending 时直接发消息 → 确认取消 + 重发行为正常
6. 刷新页面 → 确认历史会话加载正常

- [ ] **Step 4: 最终 Commit**

```bash
git add -A
git commit -m "refactor: complete ChatPage refactor - generic tools, extracted hooks, bug fixes"
```

---

## 变更总结

| 指标 | 旧 | 新 |
|------|-----|-----|
| ChatPage 行数 | ~420 | ~180 |
| 添加新交互式工具需改文件数 | 6 | 1（工具文件 + 注册） |
| config sync useEffect | 4 | 1 |
| 硬编码工具名 in ChatPage | 5 处 | 0 |
| Deferred prompt 机制 | `setTimeout(0)` | `queueMicrotask()` |

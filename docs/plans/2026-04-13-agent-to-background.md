# Agent → Background Service Worker 迁移方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Agent 执行从 sidepanel (React) 迁移到 background service worker，实现单例 agent manager + 多窗口按需订阅，彻底消除多窗口状态竞争和流式输出延迟。

**Architecture:** 单一 Background SW 持有 AgentManager（session→Agent 映射）和 Dexie DB（唯一写入者）。每个 sidepanel 通过 `chrome.runtime.connect()` 建立 Port，发送 RPC（prompt/steer/cancel），接收事件流（message_update/agent_end 等）。Interactive tools 通过 Port 跨进程通信。

**Tech Stack:** WXT, Chrome Extensions MV3, Dexie 4, pi-agent-core, pi-ai, React 19, TypeScript

---

## 一、第一性原理分析

### 1.1 问题本质

当前架构是 **"胖客户端"**：每个浏览器窗口的 sidepanel 各自实例化 Agent、管理 Dexie、维护消息状态。

```
Window 1 Sidepanel         Window 2 Sidepanel
├── Agent instance          ├── Agent instance
├── Dexie connection        ├── Dexie connection
├── React state             ├── React state
└── ThrottledWriter         └── ThrottledWriter
         │                           │
         └──── IndexedDB (冲突!) ────┘
```

**根因**：违反了 **Single Source of Truth** 原则。多个实例同时拥有数据写入权，导致：
- 同一 session 被两个窗口打开时 → 两个 Agent 各自维护 messages 数组，互不可见
- ThrottledWriter 的 3s debounce → 窗口 A 的写入覆盖窗口 B 的写入
- 流式输出只在当前窗口可见，其他窗口看到的是上一次 DB 快照

### 1.2 正确模型

Chrome Extension MV3 的 background service worker 是天然的 **单例进程**，是放置 "shared stateful services" 的唯一正确位置：

```
Window 1 Sidepanel (UI)     Window 2 Sidepanel (UI)
├── Render messages          ├── Render messages
├── Handle user input        ├── Handle user input
└── Interactive tool UI      └── Interactive tool UI
         │ Port                       │ Port
         └───────────┬────────────────┘
                     ▼
          Background Service Worker
          ├── AgentManager (singleton)
          │   └── Map<sessionId, Agent>
          ├── Dexie DB (sole writer)
          ├── Session CRUD
          ├── Tool execution (bridge)
          └── Event broadcast to all ports
```

### 1.3 这是最佳实践吗？

**是的。** 理由：

1. **Google 官方推荐**：MV3 明确将 background SW 定位为 "the extension's main event handler"，所有共享状态和业务逻辑应放在此处，UI 层（popup/sidepanel/options）作为轻量表示层。

2. **行业实践**：所有成熟的 AI 浏览器插件（Sider、Monica、Merlin 等）都将 LLM 调用放在 background，sidepanel 仅订阅事件。原因统一：sidepanel 生命周期不可控（用户可以随时切换/关闭），agent 必须在独立于 UI 的上下文中运行。

3. **架构收益**：
   - **一致性**：唯一写入者消除竞态
   - **持久性**：sidepanel 关闭不中断 agent（fetch 保持 SW alive）
   - **可扩展性**：未来加 popup、options page、content script 都能通过同一 Port 协议接入
   - **调试简化**：所有 agent 状态集中在 background，DevTools 一个 console 观察

4. **一个合理的替代方案是 SharedWorker**——但 Chrome Extension 不支持 SharedWorker，所以 background SW 是唯一选项。

### 1.4 有什么风险？

| 风险 | 严重度 | 缓解措施 |
|------|--------|----------|
| MV3 SW 空闲超时 (~30s) | 低 | Agent 运行时有活跃 fetch → 保持 alive；Port 连接也保持 alive；空闲时无需保活 |
| Port 断开（sidepanel 关闭） | 低 | Agent 继续运行（fetch 保活），下次打开时重新 connect 恢复状态 |
| Dexie 在 SW 中的兼容性 | 极低 | Dexie 4.x 明确支持 Service Worker；项目已用 4.4.2 |
| 消息序列化开销 | 极低 | Port 消息走 structured clone（非 JSON），支持大对象；streaming 频率 ~10-50 msg/s 无压力 |
| Interactive tool 跨进程通信复杂度 | 中 | 下面有详细设计，本质是 request/response 模式映射到 Port 消息 |

---

## 二、架构设计

### 2.1 通信协议 (`lib/protocol.ts`)

```
Client (Sidepanel)                    Server (Background)
────────────────────                  ──────────────────
     ── connect(port) ──────────────→
     ←── connected { activeSessions } ──
     
     ── subscribe { sessionId } ────→
     ←── session_state { messages, isRunning, ... } ──
     
     ── prompt { sessionId, text, attachments } ──→
     ←── agent_start ──
     ←── message_update { message } ──  (×N, streaming)
     ←── message_end { messages } ──
     ←── agent_end { messages } ──
     
     ── steer { sessionId, message } ──→
     ←── (same event stream) ──
     
     ── cancel { sessionId } ──→
     ←── agent_end { messages } ──
     
     ←── tool_pending { sessionId, toolName, toolCallId, args } ──
     ── resolve_tool { sessionId, toolName, response } ──→
     ── cancel_tool { sessionId, toolName } ──→
     
     ── session_create { } ──→       // no-op until first prompt
     ── session_load { sessionId } ──→
     ←── session_loaded { session } ──
     ── session_list ──→
     ←── session_list_result { sessions } ──
     ── session_delete { sessionId } ──→
     ←── session_deleted { sessionId } ──  (broadcast)
```

### 2.2 Port 管理

```typescript
// Background 维护：
portRegistry: Map<Port, { subscribedSession: string | null }>

// 一个 Port = 一个 sidepanel 实例
// 多个 Port 可以 subscribe 同一个 sessionId → 全部收到事件
// Port disconnect 时自动清理
```

### 2.3 Interactive Tool 跨进程方案

**核心洞察**：`InteractiveBridge` 本身是纯 JS，不依赖 React。它可以继续留在 background 中。UI 渲染通过 Port 消息驱动。

```
Background                              Sidepanel
──────────                              ─────────
Agent calls ask_user.execute()
  → askUserBridge.request() → Promise blocks
  → BG sends tool_pending to all subscribed ports
                                        ← receives tool_pending
                                        → renders AskUserBlock UI
                                        → user clicks option
                                        → sends resolve_tool { response }
  ← receives resolve_tool
  → askUserBridge.resolve(response) → Promise resolves
  → tool returns result → Agent continues
```

**关键**：bridge 实例和 registry 的 **逻辑部分**（resolve/cancel/hasPending）留在 background。sidepanel 只需要 **Component 映射**（toolName → React component）。

### 2.4 Page Context 采集

`gatherPageContext()` 使用 `chrome.tabs.query()` 和 `chrome.scripting.executeScript()`——这些 API 在 background SW 中可用，且行为一致。无需修改。

### 2.5 Tool 执行

所有 tools（execute_js, read_page, interact, tab, screenshot）使用 `chrome.scripting.*` 和 `chrome.tabs.*`——在 background 中完全可用。无需修改工具代码。

---

## 三、文件夹结构调整

### 3.1 原则

- `entrypoints/background/` → 放 background 特有的编排代码（port 管理、agent 生命周期管理）  
- `lib/` → 放跨上下文共享的库代码（protocol、agent factory、db、tools、storage）  
- `hooks/` → 放 React hooks（仅 sidepanel 使用）  
- 不做过度重构，只移动必要的职责

### 3.2 变更总览

```
entrypoints/
  background/
    index.ts                ← 修改：添加 port 监听，初始化 agent-manager
    agent-manager.ts        ← 新建：Agent 生命周期管理（替代 useAgentLifecycle）
    session-store.ts        ← 新建：Session CRUD 封装（唯一 DB 写入者）
    oauth-refresh.ts        ← 不变
  sidepanel/
    App.tsx                 ← 不变
    main.tsx                ← 不变
    pages/chat/index.tsx    ← 修改：换用 useAgentPort + useSessionPort

lib/
  protocol.ts               ← 新建：Port 消息类型定义
  agent.ts                  ← 不变（从 agent-manager 调用）
  db.ts                     ← 不变（从 session-store 调用）
  page-context.ts           ← 不变（从 agent-manager 调用）
  storage.ts                ← 不变
  constants.ts              ← 不变
  types.ts                  ← 不变
  tools/
    index.ts                ← 不变
    ask-user.ts             ← 不变（bridge 在 BG 中工作）
    ask-user-registry.tsx   ← 修改：拆出 UI 部分，BG 注册在 agent-manager 中
    interactive-bridge.ts   ← 不变（在 BG 中使用）
    registry.ts             ← 拆分：BG 部分（bridge 管理）+ UI 部分（Component 映射）
    execute-js.ts           ← 不变
    read-page.ts            ← 不变
    interact.ts             ← 不变
    tab.ts                  ← 不变
    screenshot.ts           ← 不变
    chrome-api.ts           ← 不变
    tool-labels.ts          ← 不变

hooks/
  useAgentPort.ts           ← 新建：替代 useAgentLifecycle
  useSessionPort.ts         ← 新建：替代 useSessionManager
  useInteractiveTools.ts    ← 修改：订阅 Port 事件而非 registry
  useStorageItem.ts         ← 不变
  useMobileEmulation.ts     ← 不变
  useAgentLifecycle.ts      ← 删除
  useSessionManager.ts      ← 删除
```

---

## 四、详细实现步骤

### Task 1: 定义通信协议 (`lib/protocol.ts`)

**Files:**
- Create: `lib/protocol.ts`

- [ ] **Step 1: 创建 protocol.ts**

```typescript
// lib/protocol.ts
// Port 通信协议：Client (sidepanel) ↔ Server (background)

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { SessionRecord } from './db';
import type { Attachment } from './attachments';

// ─── Port name ───
export const AGENT_PORT_NAME = 'cebian-agent';

// ─── Client → Background (requests) ───

export type ClientMessage =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe' }
  | { type: 'prompt'; sessionId: string | null; text: string; attachments?: Attachment[] }
  | { type: 'steer'; sessionId: string; text: string; attachments?: Attachment[] }
  | { type: 'cancel'; sessionId: string }
  | { type: 'resolve_tool'; sessionId: string; toolName: string; response: any }
  | { type: 'cancel_tool'; sessionId: string; toolName: string }
  | { type: 'session_load'; sessionId: string }
  | { type: 'session_list' }
  | { type: 'session_delete'; sessionId: string }
  | { type: 'update_config'; config: AgentConfigUpdate };

export interface AgentConfigUpdate {
  systemPrompt?: string;
  thinkingLevel?: string;
  maxRounds?: number;
  model?: { provider: string; modelId: string } | null;
}

// ─── Background → Client (events) ───

export type ServerMessage =
  | { type: 'connected' }
  | { type: 'session_state'; sessionId: string; messages: AgentMessage[]; isRunning: boolean }
  | { type: 'agent_start'; sessionId: string }
  | { type: 'message_update'; sessionId: string; message: AgentMessage }
  | { type: 'message_end'; sessionId: string; messages: AgentMessage[] }
  | { type: 'agent_end'; sessionId: string; messages: AgentMessage[] }
  | { type: 'error'; sessionId: string | null; error: string }
  | { type: 'tool_pending'; sessionId: string; toolName: string; toolCallId: string; args: any }
  | { type: 'tool_resolved'; sessionId: string; toolName: string }
  | { type: 'session_loaded'; session: SessionRecord | null }
  | { type: 'session_list_result'; sessions: Omit<SessionRecord, 'messages'>[] }
  | { type: 'session_deleted'; sessionId: string }
  | { type: 'session_created'; sessionId: string; title: string };
```

- [ ] **Step 2: Commit**

```
git add lib/protocol.ts
git commit -m "feat: define agent port communication protocol"
```

---

### Task 2: 拆分 Interactive Tool Registry

**Files:**
- Create: `lib/tools/ui-registry.ts` (sidepanel 用的 Component 映射)
- Modify: `lib/tools/registry.ts` (BG 用的 bridge 管理)
- Modify: `lib/tools/ask-user-registry.tsx` (拆分为 BG 注册 + UI 注册)

- [ ] **Step 1: 创建 `lib/tools/ui-registry.ts`**

这个文件只负责 toolName → React Component 的映射，不持有 bridge 引用。
sidepanel 通过这个 registry 知道如何渲染某个 interactive tool 的 UI。

```typescript
// lib/tools/ui-registry.ts
import type { ComponentType } from 'react';
import type { ToolResultMessage } from '@mariozechner/pi-ai';

/** Props for interactive tool UI components (rendered in sidepanel) */
export interface InteractiveToolComponentProps<TRequest = any> {
  toolCallId: string;
  args: TRequest;
  isPending: boolean;
  toolResult?: ToolResultMessage;
  onResolve?: (response: any) => void;
}

export interface UIToolRegistration<TRequest = any> {
  name: string;
  Component: ComponentType<InteractiveToolComponentProps<TRequest>>;
  renderResultAsUserBubble?: boolean;
}

class UIToolRegistry {
  private tools = new Map<string, UIToolRegistration>();

  register<TReq>(meta: UIToolRegistration<TReq>): void {
    this.tools.set(meta.name, meta as UIToolRegistration);
  }

  get(name: string): UIToolRegistration | undefined {
    return this.tools.get(name);
  }

  getAll(): UIToolRegistration[] {
    return Array.from(this.tools.values());
  }
}

export const uiToolRegistry = new UIToolRegistry();
```

- [ ] **Step 2: 修改 `ask-user-registry.tsx` — 拆出 UI 注册**

原来的 `ask-user-registry.tsx` 同时注册 bridge 和 Component。拆分为：
- **BG 侧**：在 `agent-manager.ts` 中调用 `interactiveToolRegistry.register()`（bridge 注册）
- **UI 侧**：在 `ask-user-registry.tsx` 中只注册 Component 到 `uiToolRegistry`

```tsx
// lib/tools/ask-user-registry.tsx（修改后）
import { uiToolRegistry, type InteractiveToolComponentProps } from './ui-registry';
import type { AskUserRequest } from './ask-user';
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

uiToolRegistry.register<AskUserRequest>({
  name: TOOL_ASK_USER,
  Component: AskUserToolComponent,
  renderResultAsUserBubble: true,
});
```

- [ ] **Step 3: 简化 `registry.ts` — 仅保留 BG bridge 逻辑**

`registry.ts` 变成纯 BG 侧的 bridge 管理器，移除 Component/UI 相关类型。

- [ ] **Step 4: Commit**

```
git commit -am "refactor: split interactive tool registry into bg + ui"
```

---

### Task 3: 创建 Background Session Store (`entrypoints/background/session-store.ts`)

**Files:**
- Create: `entrypoints/background/session-store.ts`

- [ ] **Step 1: 创建 session-store.ts**

封装所有 Dexie 操作，是 DB 的唯一入口。同时管理 ThrottledSessionWriter 实例。

```typescript
// entrypoints/background/session-store.ts
import {
  createSession,
  getSession,
  listSessions,
  updateSessionMessages,
  deleteSession,
  ThrottledSessionWriter,
  type SessionRecord,
} from '@/lib/db';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

class SessionStore {
  private writers = new Map<string, ThrottledSessionWriter>();

  async create(session: SessionRecord): Promise<void> {
    await createSession(session);
  }

  async load(id: string): Promise<SessionRecord | undefined> {
    return getSession(id);
  }

  async list(): Promise<Omit<SessionRecord, 'messages'>[]> {
    const all = await listSessions();
    // Strip messages for listing (avoid sending large payloads over port)
    return all.map(({ messages, ...rest }) => rest);
  }

  async delete(id: string): Promise<void> {
    await deleteSession(id);
    this.disposeWriter(id);
  }

  scheduleWrite(id: string, messages: AgentMessage[]): void {
    let writer = this.writers.get(id);
    if (!writer) {
      writer = new ThrottledSessionWriter();
      this.writers.set(id, writer);
    }
    writer.schedule(id, messages);
  }

  async flush(id: string): Promise<void> {
    const writer = this.writers.get(id);
    if (writer) await writer.flush();
  }

  private disposeWriter(id: string): void {
    const writer = this.writers.get(id);
    if (writer) {
      writer.dispose();
      this.writers.delete(id);
    }
  }
}

export const sessionStore = new SessionStore();
```

- [ ] **Step 2: Commit**

```
git commit -am "feat: add session-store for background DB management"
```

---

### Task 4: 创建 Background Agent Manager (`entrypoints/background/agent-manager.ts`)

**Files:**
- Create: `entrypoints/background/agent-manager.ts`

这是核心文件，迁移自 `useAgentLifecycle.ts` 的逻辑。

- [ ] **Step 1: 创建 agent-manager.ts 基础结构**

```typescript
// entrypoints/background/agent-manager.ts
import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model, Message } from '@mariozechner/pi-ai';
import { createCebianAgent } from '@/lib/agent';
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/constants';
import { sessionStore } from './session-store';
import { gatherPageContext } from '@/lib/page-context';
import { buildTextPrefix, extractImages, type Attachment } from '@/lib/attachments';
import { extractUserText } from '@/lib/message-helpers';
import { interactiveToolRegistry } from '@/lib/tools/registry';
import type { ServerMessage, AgentConfigUpdate } from '@/lib/protocol';
import type { SessionRecord } from '@/lib/db';
import {
  providerCredentials,
  customProviders as customProvidersStorage,
  activeModel as activeModelStorage,
  thinkingLevel as thinkingLevelStorage,
  systemPrompt as systemPromptStorage,
  maxRounds as maxRoundsStorage,
  type ProviderCredentials,
} from '@/lib/storage';
import { getCopilotBaseUrl } from '@/lib/oauth';
import { mergeCustomProviders, isCustomProvider, findCustomModel } from '@/lib/custom-models';
import { PRESET_PROVIDERS } from '@/lib/constants';
import { getModels, type KnownProvider } from '@mariozechner/pi-ai';

// ─── Types ───

interface ManagedSession {
  agent: Agent;
  sessionId: string;
  sessionCreated: boolean;
  unsubscribe: () => void;
}

type BroadcastFn = (sessionId: string, msg: ServerMessage) => void;

// ─── Agent Manager ───

class AgentManager {
  private sessions = new Map<string, ManagedSession>();
  private broadcast: BroadcastFn = () => {};

  setBroadcast(fn: BroadcastFn): void {
    this.broadcast = fn;
  }

  /** Get or create a managed agent for a session */
  private async getOrCreateAgent(sessionId: string): Promise<ManagedSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    // Load config from storage
    const [model, thinkingLvl, sysPrompt, rounds, creds, customProvs] = await Promise.all([
      activeModelStorage.getValue(),
      thinkingLevelStorage.getValue(),
      systemPromptStorage.getValue(),
      maxRoundsStorage.getValue(),
      providerCredentials.getValue(),
      customProvidersStorage.getValue(),
    ]);

    if (!model) throw new Error('No model selected');

    const modelObj = this.resolveModel(model.provider, model.modelId, customProvs ?? [], creds);
    if (!modelObj) throw new Error(`Model not found: ${model.provider}/${model.modelId}`);

    // Load existing messages if session exists in DB
    const existingSession = await sessionStore.load(sessionId);
    const messages = existingSession?.messages ?? [];

    const agent = createCebianAgent({
      model: modelObj,
      systemPrompt: sysPrompt || DEFAULT_SYSTEM_PROMPT,
      thinkingLevel: (thinkingLvl || 'medium') as any,
      maxRounds: rounds || 200,
      messages,
    });

    const managed: ManagedSession = {
      agent,
      sessionId,
      sessionCreated: !!existingSession,
      unsubscribe: () => {},
    };

    // Subscribe to agent events
    managed.unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      await this.handleAgentEvent(managed, event);
    });

    this.sessions.set(sessionId, managed);
    return managed;
  }

  private async handleAgentEvent(managed: ManagedSession, event: AgentEvent): Promise<void> {
    const { sessionId, agent } = managed;

    switch (event.type) {
      case 'agent_start':
        this.broadcast(sessionId, { type: 'agent_start', sessionId });
        break;

      case 'message_update':
        if ('role' in event.message && event.message.role === 'assistant') {
          this.broadcast(sessionId, {
            type: 'message_update',
            sessionId,
            message: event.message,
          });
        }
        break;

      case 'message_end':
        this.broadcast(sessionId, {
          type: 'message_end',
          sessionId,
          messages: [...agent.state.messages],
        });
        if (managed.sessionCreated) {
          sessionStore.scheduleWrite(sessionId, agent.state.messages);
        }
        break;

      case 'agent_end': {
        const messages = [...agent.state.messages];
        this.broadcast(sessionId, { type: 'agent_end', sessionId, messages });

        if (!managed.sessionCreated && messages.length > 0) {
          // Create session in DB
          const firstUserText = extractUserText(messages[0]);
          const title = firstUserText.slice(0, 50) + (firstUserText.length > 50 ? '...' : '');
          const model = await activeModelStorage.getValue();
          const sysPrompt = await systemPromptStorage.getValue();
          const thinkingLvl = await thinkingLevelStorage.getValue();

          const session: SessionRecord = {
            id: sessionId,
            title: title || '新对话',
            model: model?.modelId ?? '',
            provider: model?.provider ?? '',
            systemPrompt: sysPrompt || '',
            thinkingLevel: thinkingLvl || 'medium',
            messageCount: messages.length,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCost: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages,
          };
          await sessionStore.create(session);
          managed.sessionCreated = true;
          this.broadcast(sessionId, {
            type: 'session_created',
            sessionId,
            title: session.title,
          });
        } else {
          await sessionStore.flush(sessionId);
        }
        break;
      }
    }

    // Check for pending interactive tools after each event
    this.checkPendingTools(sessionId);
  }

  private checkPendingTools(sessionId: string): void {
    for (const info of interactiveToolRegistry.getAll()) {
      const pending = interactiveToolRegistry.getPendingFor(info.name);
      if (pending) {
        this.broadcast(sessionId, {
          type: 'tool_pending',
          sessionId,
          toolName: info.name,
          toolCallId: pending.toolCallId,
          args: pending.request,
        });
      }
    }
  }

  /** Send a prompt to the agent for a session */
  async prompt(sessionId: string, text: string, attachments: Attachment[] = []): Promise<void> {
    const managed = await this.getOrCreateAgent(sessionId);
    const ctx = await gatherPageContext();

    const parts: string[] = [];
    if (ctx) parts.push(ctx);
    const prefix = buildTextPrefix(attachments);
    if (prefix) parts.push(prefix);
    parts.push(text);
    const enriched = parts.join('\n\n');

    const images = extractImages(attachments);

    if (interactiveToolRegistry.hasPending()) {
      const content: any[] = [{ type: 'text', text: enriched }];
      if (images.length > 0) content.push(...images);
      const userMessage: AgentMessage = {
        role: 'user',
        content,
        timestamp: Date.now(),
      } as AgentMessage;
      managed.agent.steer(userMessage);
      interactiveToolRegistry.cancelAll();
    } else {
      await managed.agent.prompt(enriched, images.length > 0 ? images : undefined);
    }
  }

  /** Cancel the active agent for a session */
  cancel(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      managed.agent.abort();
    }
  }

  /** Resolve an interactive tool */
  resolveTool(sessionId: string, toolName: string, response: any): void {
    interactiveToolRegistry.resolve(toolName, response);
  }

  /** Cancel an interactive tool */
  cancelTool(sessionId: string, toolName: string): void {
    // Will be handled by cancelAll or specific cancel
    const info = interactiveToolRegistry.getAll().find(t => t.name === toolName);
    if (info) {
      // Cancel specific tool's pending request
      interactiveToolRegistry.resolve(toolName, undefined);
    }
  }

  /** Get current state for a session (for reconnecting clients) */
  getState(sessionId: string): { messages: AgentMessage[]; isRunning: boolean } | null {
    const managed = this.sessions.get(sessionId);
    if (!managed) return null;
    return {
      messages: [...managed.agent.state.messages],
      isRunning: managed.agent.isRunning ?? false,
    };
  }

  /** Destroy a managed session (when deleted or no more subscribers) */
  destroySession(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      managed.unsubscribe();
      managed.agent.abort();
      this.sessions.delete(sessionId);
    }
  }

  private resolveModel(
    provider: string,
    modelId: string,
    customProviders: import('@/lib/storage').CustomProviderConfig[],
    creds: ProviderCredentials,
  ): Model<Api> | undefined {
    const allCustom = mergeCustomProviders(PRESET_PROVIDERS, customProviders);
    let model: Model<Api> | undefined;

    if (isCustomProvider(provider)) {
      model = findCustomModel(allCustom, provider, modelId) ?? undefined;
    } else {
      try {
        const models = getModels(provider as KnownProvider) as Model<Api>[];
        model = models.find(m => m.id === modelId);
      } catch {
        return undefined;
      }
    }
    if (!model) return undefined;

    if (provider === 'github-copilot') {
      const cred = creds[provider];
      if (cred?.authType === 'oauth') {
        return { ...model, baseUrl: getCopilotBaseUrl(cred) };
      }
    }

    return model;
  }
}

export const agentManager = new AgentManager();
```

- [ ] **Step 2: Commit**

```
git commit -am "feat: add agent-manager for background agent lifecycle"
```

---

### Task 5: 修改 Background Entry (`entrypoints/background/index.ts`)

**Files:**
- Modify: `entrypoints/background/index.ts`

- [ ] **Step 1: 添加 Port 监听和消息路由**

```typescript
// entrypoints/background/index.ts
import { setupOAuthRefresh } from './oauth-refresh';
import { agentManager } from './agent-manager';
import { sessionStore } from './session-store';
import { AGENT_PORT_NAME, type ClientMessage, type ServerMessage } from '@/lib/protocol';

// Import tool bridge registrations (side-effect)
import '@/lib/tools/ask-user-bridge-register';

export default defineBackground(() => {
  console.log('Cebian background started', { id: browser.runtime.id });

  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));

  setupOAuthRefresh();

  // ─── Port management ───

  const ports = new Map<chrome.runtime.Port, { subscribedSession: string | null }>();

  function broadcast(sessionId: string, msg: ServerMessage): void {
    for (const [port, state] of ports) {
      if (state.subscribedSession === sessionId) {
        try { port.postMessage(msg); } catch { /* port disconnected */ }
      }
    }
  }

  agentManager.setBroadcast(broadcast);

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== AGENT_PORT_NAME) return;

    ports.set(port, { subscribedSession: null });
    port.postMessage({ type: 'connected' } satisfies ServerMessage);

    port.onMessage.addListener(async (msg: ClientMessage) => {
      try {
        await handleClientMessage(port, msg);
      } catch (err: any) {
        port.postMessage({
          type: 'error',
          sessionId: null,
          error: err.message ?? String(err),
        } satisfies ServerMessage);
      }
    });

    port.onDisconnect.addListener(() => {
      ports.delete(port);
    });
  });

  async function handleClientMessage(port: chrome.runtime.Port, msg: ClientMessage): Promise<void> {
    const state = ports.get(port);
    if (!state) return;

    switch (msg.type) {
      case 'subscribe': {
        state.subscribedSession = msg.sessionId;
        // Send current state if agent is running
        const agentState = agentManager.getState(msg.sessionId);
        if (agentState) {
          port.postMessage({
            type: 'session_state',
            sessionId: msg.sessionId,
            messages: agentState.messages,
            isRunning: agentState.isRunning,
          } satisfies ServerMessage);
        }
        break;
      }

      case 'unsubscribe':
        state.subscribedSession = null;
        break;

      case 'prompt': {
        const sessionId = msg.sessionId ?? crypto.randomUUID();
        state.subscribedSession = sessionId;
        await agentManager.prompt(sessionId, msg.text, msg.attachments);
        break;
      }

      case 'cancel':
        agentManager.cancel(msg.sessionId);
        break;

      case 'resolve_tool':
        agentManager.resolveTool(msg.sessionId, msg.toolName, msg.response);
        break;

      case 'cancel_tool':
        agentManager.cancelTool(msg.sessionId, msg.toolName);
        break;

      case 'session_load': {
        const session = await sessionStore.load(msg.sessionId);
        port.postMessage({
          type: 'session_loaded',
          session: session ?? null,
        } satisfies ServerMessage);
        break;
      }

      case 'session_list': {
        const sessions = await sessionStore.list();
        port.postMessage({
          type: 'session_list_result',
          sessions,
        } satisfies ServerMessage);
        break;
      }

      case 'session_delete': {
        await sessionStore.delete(msg.sessionId);
        agentManager.destroySession(msg.sessionId);
        // Broadcast to all ports
        for (const [p] of ports) {
          try {
            p.postMessage({
              type: 'session_deleted',
              sessionId: msg.sessionId,
            } satisfies ServerMessage);
          } catch { /* disconnected */ }
        }
        break;
      }
    }
  }
});
```

- [ ] **Step 2: Commit**

```
git commit -am "feat: add port listener and message router to background"
```

---

### Task 6: 创建 Sidepanel Port Hooks

**Files:**
- Create: `hooks/useAgentPort.ts`
- Create: `hooks/useSessionPort.ts`

- [ ] **Step 1: 创建 `hooks/useAgentPort.ts`**

替代 `useAgentLifecycle` — 通过 Port 与 background 通信。

```typescript
// hooks/useAgentPort.ts
import { useState, useRef, useEffect, useCallback } from 'react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { AGENT_PORT_NAME, type ClientMessage, type ServerMessage } from '@/lib/protocol';
import type { Attachment } from '@/lib/attachments';

export interface AgentPortState {
  messages: AgentMessage[];
  isAgentRunning: boolean;
  sessionId: string | null;
  sessionTitle: string;
  connected: boolean;
}

export interface AgentPortActions {
  send: (text: string, attachments?: Attachment[]) => void;
  cancel: () => void;
  subscribe: (sessionId: string) => void;
  loadSession: (sessionId: string) => void;
  listSessions: () => void;
  deleteSession: (sessionId: string) => void;
  resolveTool: (toolName: string, response: any) => void;
}

export function useAgentPort(opts: {
  onSessionCreated?: (sessionId: string, title: string) => void;
  onSessionLoaded?: (session: any) => void;
  onSessionList?: (sessions: any[]) => void;
  onSessionDeleted?: (sessionId: string) => void;
}) {
  const [state, setState] = useState<AgentPortState>({
    messages: [],
    isAgentRunning: false,
    sessionId: null,
    sessionTitle: '',
    connected: false,
  });

  // Track pending tool states for UI rendering
  const [pendingTools, setPendingTools] = useState<Map<string, { toolCallId: string; args: any }>>(new Map());

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  // Connect to background on mount
  useEffect(() => {
    const port = chrome.runtime.connect({ name: AGENT_PORT_NAME });
    portRef.current = port;

    port.onMessage.addListener((msg: ServerMessage) => {
      switch (msg.type) {
        case 'connected':
          setState(prev => ({ ...prev, connected: true }));
          break;

        case 'session_state':
          sessionIdRef.current = msg.sessionId;
          setState(prev => ({
            ...prev,
            sessionId: msg.sessionId,
            messages: msg.messages,
            isAgentRunning: msg.isRunning,
          }));
          break;

        case 'agent_start':
          setState(prev => ({ ...prev, isAgentRunning: true }));
          break;

        case 'message_update':
          setState(prev => {
            const msgs = [...prev.messages];
            const last = msgs[msgs.length - 1];
            if (last && 'role' in last && last.role === 'assistant') {
              msgs[msgs.length - 1] = msg.message;
            } else {
              msgs.push(msg.message);
            }
            return { ...prev, messages: msgs };
          });
          break;

        case 'message_end':
          setState(prev => ({ ...prev, messages: msg.messages }));
          break;

        case 'agent_end':
          setState(prev => ({
            ...prev,
            messages: msg.messages,
            isAgentRunning: false,
          }));
          setPendingTools(new Map());
          break;

        case 'tool_pending':
          setPendingTools(prev => {
            const next = new Map(prev);
            next.set(msg.toolName, { toolCallId: msg.toolCallId, args: msg.args });
            return next;
          });
          break;

        case 'tool_resolved':
          setPendingTools(prev => {
            const next = new Map(prev);
            next.delete(msg.toolName);
            return next;
          });
          break;

        case 'session_created':
          sessionIdRef.current = msg.sessionId;
          setState(prev => ({
            ...prev,
            sessionId: msg.sessionId,
            sessionTitle: msg.title,
          }));
          opts.onSessionCreated?.(msg.sessionId, msg.title);
          break;

        case 'session_loaded':
          opts.onSessionLoaded?.(msg.session);
          break;

        case 'session_list_result':
          opts.onSessionList?.(msg.sessions);
          break;

        case 'session_deleted':
          opts.onSessionDeleted?.(msg.sessionId);
          break;

        case 'error':
          console.error('[AgentPort] Error:', msg.error);
          setState(prev => ({ ...prev, isAgentRunning: false }));
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      setState(prev => ({ ...prev, connected: false }));
      portRef.current = null;
    });

    return () => {
      port.disconnect();
      portRef.current = null;
    };
  }, []);

  const postMessage = useCallback((msg: ClientMessage) => {
    portRef.current?.postMessage(msg);
  }, []);

  const actions: AgentPortActions = {
    send: useCallback((text: string, attachments?: Attachment[]) => {
      if (!text.trim()) return;
      const sessionId = sessionIdRef.current;
      postMessage({ type: 'prompt', sessionId, text, attachments });
      setState(prev => ({ ...prev, isAgentRunning: true }));
    }, [postMessage]),

    cancel: useCallback(() => {
      const sessionId = sessionIdRef.current;
      if (sessionId) postMessage({ type: 'cancel', sessionId });
    }, [postMessage]),

    subscribe: useCallback((sessionId: string) => {
      sessionIdRef.current = sessionId;
      postMessage({ type: 'subscribe', sessionId });
    }, [postMessage]),

    loadSession: useCallback((sessionId: string) => {
      postMessage({ type: 'session_load', sessionId });
    }, [postMessage]),

    listSessions: useCallback(() => {
      postMessage({ type: 'session_list' });
    }, [postMessage]),

    deleteSession: useCallback((sessionId: string) => {
      postMessage({ type: 'session_delete', sessionId });
    }, [postMessage]),

    resolveTool: useCallback((toolName: string, response: any) => {
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        postMessage({ type: 'resolve_tool', sessionId, toolName, response });
        setPendingTools(prev => {
          const next = new Map(prev);
          next.delete(toolName);
          return next;
        });
      }
    }, [postMessage]),
  };

  return { state, actions, pendingTools };
}
```

- [ ] **Step 2: Commit**

```
git commit -am "feat: add useAgentPort hook for sidepanel-to-background communication"
```

---

### Task 7: 修改 ChatPage 使用新 Hooks

**Files:**
- Modify: `entrypoints/sidepanel/pages/chat/index.tsx`

- [ ] **Step 1: 重写 ChatPage**

将 `useAgentLifecycle` + `useSessionManager` 替换为 `useAgentPort`。
保留所有 UI 渲染逻辑，只改数据来源。

关键变化：
- `messages`, `isAgentRunning` 来自 `useAgentPort().state`
- `handleSend` 变为 `actions.send()`
- 加载已有 session 变为 `actions.subscribe(sessionId)`
- interactive tool 的 pending 状态来自 `pendingTools` Map
- `resolve` 变为 `actions.resolveTool()`
- 移除 `modelObj` 的本地解析（background 负责）
- 保留 `useStorageItem` 读取 `activeModel` 用于 UI 显示（判断是否选了模型）

- [ ] **Step 2: Commit**

```
git commit -am "refactor: ChatPage uses useAgentPort instead of local agent"
```

---

### Task 8: 修改 HistoryPanel 使用 Port

**Files:**
- Modify: `components/layout/HistoryPanel.tsx`

- [ ] **Step 1: 修改 HistoryPanel 数据来源**

当前 HistoryPanel 直接调用 `listSessions()` / `deleteSession()` from `@/lib/db`。
改为通过 Port 请求 background。

有两种方式：
- A) 共享 useAgentPort 的 port（推荐，避免多 port 连接）
- B) HistoryPanel 自己连 port

推荐 A：通过 props 或 context 传入 `listSessions` / `deleteSession` 回调。

- [ ] **Step 2: Commit**

```
git commit -am "refactor: HistoryPanel fetches sessions via background port"
```

---

### Task 9: 清理旧代码

**Files:**
- Delete: `hooks/useAgentLifecycle.ts`
- Delete: `hooks/useSessionManager.ts`
- Modify: `hooks/useInteractiveTools.ts` (移除或标记废弃)

- [ ] **Step 1: 删除旧 hooks**

`useAgentLifecycle.ts` 和 `useSessionManager.ts` 的功能已完全迁移到 background + useAgentPort。

- [ ] **Step 2: 简化 useInteractiveTools**

这个 hook 原来订阅 `interactiveToolRegistry` 的 pending 状态。
现在 pending 状态来自 Port 消息（`pendingTools` Map in useAgentPort）。
可以直接删除这个 hook，或保留为轻量 wrapper。

- [ ] **Step 3: Commit**

```
git commit -am "chore: remove deprecated hooks (useAgentLifecycle, useSessionManager)"
```

---

### Task 10: 端到端测试和修复

- [ ] **Step 1: 单窗口测试**
  - 启动 dev，打开 sidepanel
  - 新建会话，发送消息，确认流式输出
  - 确认 session 持久化
  - 刷新 sidepanel，确认历史加载

- [ ] **Step 2: 多窗口测试**
  - 打开两个浏览器窗口各自打开 sidepanel
  - 在窗口 A 发消息，确认窗口 B 同步看到
  - 同时订阅同一 session，确认流式输出同步

- [ ] **Step 3: Interactive tool 测试**
  - 触发 ask_user tool
  - 确认 UI 在 sidepanel 正确渲染
  - 点击选项，确认 agent 恢复

- [ ] **Step 4: 异常场景测试**
  - 关闭 sidepanel mid-stream → 重新打开 → 确认状态恢复
  - 删除会话 → 确认所有窗口同步

- [ ] **Step 5: Commit final fixes**

```
git commit -am "fix: end-to-end fixes for background agent migration"
```

---

## 五、迁移风险缓解

### 5.1 渐进式迁移策略

如果担心一次性迁移风险太大，可以分两阶段：

**Phase A（可选）：Background 并行运行**
- 新代码写在 background，原 sidepanel 逻辑保留
- 增加一个 feature flag `useBackgroundAgent` (storage toggle)
- 两套代码并存，通过 flag 切换

**Phase B：全量切换**
- 默认启用 background agent
- 删除旧代码

### 5.2 回滚方案

整个迁移在一个 git branch 上完成。完成前不 merge 到 main。任何时候可以直接切回 main 回滚。

---

## 六、总结

| 维度 | 现状 | 迁移后 |
|------|------|--------|
| Agent 实例 | 每窗口一个 | 全局单例管理 |
| DB 写入者 | 每窗口一个 ThrottledWriter | Background 唯一写入者 |
| 跨窗口同步 | ❌ 不同步 | ✅ 实时 broadcast |
| Sidepanel 关闭 | ❌ Agent 被杀 | ✅ Agent 继续运行 |
| 代码复杂度 | React hooks 嵌套 | Port RPC + 事件流 |
| 新增文件 | — | 5 个（protocol, agent-manager, session-store, useAgentPort, ui-registry） |
| 删除文件 | — | 2 个（useAgentLifecycle, useSessionManager） |
| 修改文件 | — | 4 个（background/index, chat/index, HistoryPanel, ask-user-registry） |

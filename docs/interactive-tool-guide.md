# 如何添加新的 Interactive Tool

Interactive Tool 是一种特殊的 agent 工具：它会**暂停 agent 执行**，在 sidepanel 中显示 UI 让用户交互（比如选择选项、确认操作），然后将用户的响应返回给 agent 继续执行。

本文以 `ask_user` 为参考，说明添加一个新 interactive tool 的完整步骤。

## 架构概览

```
Background Service Worker                Sidepanel (React)
─────────────────────────                ─────────────────
Agent 调用 tool.execute()
  → bridge.request()  ──(Port)──→  UI 渲染工具组件
                                   用户操作
  ← bridge.resolve()  ←──(Port)──  发送 resolve_tool 消息
Agent 继续执行
```

涉及的核心模块：

| 模块 | 位置 | 职责 |
|------|------|------|
| InteractiveBridge | `lib/tools/interactive-bridge.ts` | 通用 bridge 工厂（不需要修改） |
| SessionToolContext | `lib/tools/session-context.ts` | 管理一个 session 所有 bridge（不需要修改） |
| UIToolRegistry | `lib/tools/ui-registry.ts` | 映射工具名 → React 组件（不需要修改） |

## 步骤

### 1. 定义工具名常量

在 `lib/types.ts` 中添加：

```ts
export const TOOL_CONFIRM_ACTION = 'confirm_action' as const;
```

### 2. 创建工具文件

新建 `lib/tools/confirm-action.ts`：

```ts
import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { createInteractiveBridge, INTERACTIVE_CANCELLED, type InteractiveBridge } from './interactive-bridge';
import { TOOL_CONFIRM_ACTION } from '@/lib/types';

// ─── 参数 Schema（暴露给 LLM）───

const ConfirmActionParameters = Type.Object({
  message: Type.String({ description: '需要用户确认的操作描述' }),
  destructive: Type.Optional(Type.Boolean({ description: '是否为危险操作' })),
});

export type ConfirmActionRequest = Static<typeof ConfirmActionParameters>;

// ─── 工厂函数：每个 session 创建独立实例 ───

export function createSessionConfirmTool(): {
  tool: AgentTool<typeof ConfirmActionParameters>;
  bridge: InteractiveBridge<ConfirmActionRequest, boolean>;
} {
  const bridge = createInteractiveBridge<ConfirmActionRequest, boolean>();

  const tool: AgentTool<typeof ConfirmActionParameters> = {
    name: TOOL_CONFIRM_ACTION,
    label: 'Confirm Action',
    description: 'Ask the user to confirm before performing a potentially impactful action.',
    parameters: ConfirmActionParameters,

    async execute(toolCallId, params, signal): Promise<AgentToolResult> {
      const result = await bridge.request(toolCallId, params, signal);

      if (result === INTERACTIVE_CANCELLED) {
        return {
          content: [{ type: 'text', text: '用户取消了操作。' }],
          details: { confirmed: false },
        };
      }

      return {
        content: [{ type: 'text', text: result ? '用户确认了操作。' : '用户拒绝了操作。' }],
        details: { confirmed: result },
      };
    },
  };

  return { tool, bridge };
}
```

**关键点**：
- 使用 `createInteractiveBridge<TRequest, TResponse>()` 工厂，不要创建全局单例
- 导出工厂函数 `createSession*Tool()`，返回 `{ tool, bridge }`
- `TResponse` 是用户响应的类型（ask_user 是 `string`，confirm 可以是 `boolean`）

### 3. 注册到 SessionToolContext

修改 `lib/tools/index.ts` 的 `createSessionTools()`：

```ts
import { createSessionConfirmTool } from './confirm-action';
import { TOOL_CONFIRM_ACTION } from '@/lib/types';

export async function createSessionTools() {
  const ctx = new SessionToolContext();

  const { tool: askUserTool, bridge: askUserBridge } = createSessionAskUserTool();
  ctx.register(TOOL_ASK_USER, askUserBridge, askUserTool);

  // ▼ 新增两行 ▼
  const { tool: confirmTool, bridge: confirmBridge } = createSessionConfirmTool();
  ctx.register(TOOL_CONFIRM_ACTION, confirmBridge, confirmTool);

  const tools = await buildSessionToolArray(ctx);
  return { tools, ctx };
}
```

**关键点**：
- `ctx.register(name, bridge, tool)` 的第三个参数是该 tool 实例。`SessionToolContext` 会把所有注册的 interactive tools 收集起来，`buildSessionToolArray(ctx)` 自动取出，无需手动拼接 tools 数组。
- **完成后 `agent-manager.ts` 零改动** —— 它只通过 `ctx` 间接接触工具，永远不知道 `confirm_action` 的存在。MCP 配置变化时的 `refreshAllSessionTools` 也会自动包含这个新工具。

### 4. 创建 UI 组件

新建 `lib/tools/confirm-action-registry.tsx`：

```tsx
import { uiToolRegistry, type InteractiveToolComponentProps } from './ui-registry';
import type { ConfirmActionRequest } from './confirm-action';
import { TOOL_CONFIRM_ACTION } from '@/lib/types';

function ConfirmActionComponent({
  args,
  isPending,
  toolResult,
  onResolve,
}: InteractiveToolComponentProps<ConfirmActionRequest>) {
  // 渲染你的确认 UI
  return (
    <div>
      <p>{args.message}</p>
      {isPending && (
        <div>
          <button onClick={() => onResolve?.(true)}>确认</button>
          <button onClick={() => onResolve?.(false)}>取消</button>
        </div>
      )}
      {!isPending && toolResult && <p>已回复</p>}
    </div>
  );
}

uiToolRegistry.register<ConfirmActionRequest>({
  name: TOOL_CONFIRM_ACTION,
  Component: ConfirmActionComponent,
  renderResultAsUserBubble: false, // 确认结果不需要渲染为用户气泡
});
```

**Props 说明**：

| Prop | 类型 | 说明 |
|------|------|------|
| `args` | `TRequest` | LLM 传入的工具参数 |
| `isPending` | `boolean` | 是否正在等待用户响应 |
| `toolResult` | `ToolResultMessage?` | agent 收到的工具结果（已回复后才有） |
| `onResolve` | `(response) => void?` | 调用此函数提交用户响应（仅 isPending 时存在） |

### 5. 注册 UI 组件

修改 `lib/tools/ui-registrations.ts`，加一行：

```ts
import './ask-user-registry';
import './confirm-action-registry';  // ← 新增
```

### 6. 更新系统提示词（可选）

如果需要 LLM 知道这个工具的存在，在 `lib/constants.ts` 的 `DEFAULT_SYSTEM_PROMPT` 中添加工具说明。

## Checklist

| 步骤 | 文件 | 操作 |
|------|------|------|
| 1. 定义常量 | `lib/types.ts` | 加 `TOOL_*` 常量 |
| 2. 创建工具 | `lib/tools/{name}.ts` | 工厂函数 + bridge |
| 3. 注册 bridge | `lib/tools/index.ts` | `ctx.register(name, bridge, tool)` |
| 4. 创建 UI | `lib/tools/{name}-registry.tsx` | React 组件 + `uiToolRegistry.register()` |
| 5. 注册 UI | `lib/tools/ui-registrations.ts` | `import './{name}-registry'` |
| 6. 系统提示词 | `lib/constants.ts` | 可选 |

**不需要修改的文件**：`agent-manager.ts`、`useBackgroundAgent.ts`、`ChatPage`、`interactive-bridge.ts`、`session-context.ts`、`ui-registry.ts`。

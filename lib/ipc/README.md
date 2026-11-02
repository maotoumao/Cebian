# IPC 通信契约

`lib/ipc/` 是 Cebian 在扩展执行上下文之间共享的通信契约层。它定义 UI、background 和 sandbox 在跨上下文协作时共同依赖的消息形状与边界；它不负责业务调度、会话持久化或 UI 状态。

## 目录职责

| 文件 | 职责 | 主要使用方 |
| --- | --- | --- |
| `protocol.ts` | 定义 UI 实例与 background 间的长连接 Port 名称、请求、事件及相关共享类型 | sidepanel hooks、background 的 Port 路由、会话/录制/MCP 模块 |
| `instance-id.ts` | 为一个 sidepanel 或独立标签页的 JavaScript 运行时生成唯一实例 ID | UI 侧录制与其他需要识别发起 UI 实例的流程 |
| `sandbox-binary.ts` | 在 sandbox/offscreen 与 background 的 JSON 消息边界上编码、还原二进制值 | `entrypoints/sandbox/main.ts`、`lib/tools/sandbox-rpc.ts` |

## UI 与 Background 的 Port 协议

`protocol.ts` 服务的是一个 UI 实例到 background 的长期连接。UI 用 `CLIENT_PORT` 建立 `chrome.runtime.Port`，然后通过：

- `ClientMessage` 发送请求，例如订阅会话、发送提示词、取消运行、处理工具权限、管理会话、控制录制器、读取 MCP 资源和整理记忆。
- `ServerMessage` 接收 background 推送的状态与结果，例如会话快照、流式增量、工具状态、错误、会话列表和录制器状态。

聊天 UI 实例只应持有一条由 `useBackgroundAgent` 管理的 Port。会话列表、MCP 和录制器通过各自的 `*-channel.ts` 适配层复用它，不能为这些领域重复建立平行的客户端连接。记忆整理是例外：它是独立于会话的全局后台任务，`useMemoryOrganize` 在挂载期间维护自己的 Port，以接收跨界面广播的整理状态。

### 流式消息

`stream_ops` 是全量会话边界之间的增量帧：background 将 `pi-agent-core` 的流式事件压缩为 `StreamOp[]`，UI 用 `lib/agent/stream-replica.ts` 应用到本地副本。`session_state`、`message_end` 和 `agent_end` 是权威的全量边界；若增量应用失败或副本漂移，订阅方应重新发送 `subscribe` 拉取快照，而不是猜测如何修复本地消息。

`BroadcastMessage` 只是在 IPC 副本上附加可选的 `entryId`，以支持编辑、重试、分支切换和分叉等按树节点定位的操作。不要把该 ID 写回 `agent.state.messages`，否则会污染会话树中由 agent 管理的消息。

### 请求与响应边界

Port 适用于 background 需要主动推送或 UI 需要实时同步的领域。一次性的 `chrome.runtime.sendMessage` 适用于短问答，但它不是按接收者寻址的投递：所有扩展上下文中的监听器都可能收到消息，handler 必须先判断消息是否属于自己，不匹配时不应答也不返回 Promise。

两种通信都需要留意 Chrome 的单条消息大小上限。大载荷必须采用已建立的分块或本地直读设计，不能将完整备份或二进制数据直接塞进普通运行时消息。

## UI 实例标识

`instance-id.ts` 在 UI JavaScript 运行时加载时生成一次 `myInstanceId`。它在该运行时存活期间保持稳定，刷新页面则生成新的 ID。UI 通过 `hello` Port 消息将其发送给 background。

这个 ID 表示发起请求的 UI 实例，而不是窗口。录制器据此判断哪个实例拥有停止录制的权限，也能在对应 Port 断开时识别发起者离开。background 没有自己的 UI 实例，因此不得从 `entrypoints/background/*` 导入 `myInstanceId`。

## Sandbox 二进制封装

`chrome.runtime.sendMessage` 在 sandbox/offscreen 到 background 的路径中使用 JSON 序列化，而不是 structured clone。直接传递 `Uint8Array`、`ArrayBuffer` 或其他 `ArrayBufferView` 会丢失其二进制类型信息。

`sandbox-binary.ts` 用 `{ __cebianBin: "<base64>" }` 信封编码这些值，并在接收端还原为 `Uint8Array`：

- 单个值使用 `encodeBinary` 与 `decodeBinary`。
- RPC 参数数组使用 `encodeBinaryArgs` 与 `decodeBinaryArgs`。
- `Blob` 和 `File` 不支持直接传递；调用方必须先异步读取为字节数组，否则函数会抛出明确错误，避免 JSON 序列化成空对象造成静默数据损坏。

封装只处理传入数组的顶层元素，不递归遍历深层对象。新增 RPC 如果需要传递嵌套二进制结构，应先调整并验证这项明确的协议约束，而不是假设现有编码器会自动覆盖它。

## 修改约定

修改 `protocol.ts` 时，应同时检查以下事项：

1. 新增 `ClientMessage` 类型时，同步更新 `CLIENT_MESSAGE_TYPES`。该清单受类型级穷尽性检查保护，也供 background 路由测试枚举。
2. 为请求选择正确的回传方式：需要所有已连接 UI 同步的状态使用广播；只属于发起实例的结果或失败只回复该 Port。不要复用会被聊天视图解释为本轮 agent 错误的通用 `error` 事件来表达列表、会话写入等独立操作失败。
3. 为会话树操作使用 IPC 层的 `BroadcastMessage.entryId`，并保持 `AgentMessage` 本体不含该展示/定位字段。
4. 变更流式帧时，同时审查 background 的 `stream-broadcast.ts` 和 UI 的 `stream-replica.ts`，并以全量边界能够校正副本为前提。
5. 新增跨上下文二进制参数时，确认发送端和接收端都使用本目录的编码器，并覆盖 `Blob`/`File` 与嵌套对象的限制。

`lib/ipc/` 只保存跨上下文都必须认同的协议与小型传输适配。具体业务行为应留在所属领域：background 编排在 `entrypoints/background/`，UI 状态和交互在 hooks 或 components，会话数据持久化在 `lib/persistence/`。

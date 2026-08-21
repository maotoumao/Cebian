// Client ↔ background 的端口通信协议。
// Client = 一个 UI 实例（侧边栏，或独立标签页里打开的同一套界面）。
//
// ─── 什么走端口、什么走 sendMessage ───
//
// 端口（Port）≈ WebSocket：需要 background 主动推送 / 实时同步时用。
// sendMessage ≈ HTTP：一次性问答用。
//
// 约定：一个 UI 实例只开一条端口，同一上下文里的其它域走 channel shim 复用它
// （见 lib/mcp/sidepanel-channel.ts、lib/recorder/sidepanel-channel.ts）。
// 现状有例外：HistoryPanel 为 session_list / session_delete 各开一条一次性端口，待收口。
//
// 注意 `chrome.runtime.sendMessage` 不是寻址投递：它送达发送方之外的所有扩展上下文
// （background 与已打开的扩展页面；要定向到内容脚本得用 chrome.tabs.sendMessage）。
// 所有监听器都会被调用，只有第一个应答的算数——所以每个 handler 必须先判别消息是不是
// 自己的，不是就既不应答也不返回 promise，把机会让给别人。单条消息另有 ~64MiB 上限：
// 备份的恢复因此改成分块传输，采集则改为页面侧直读 Dexie、消息只发一个无 payload 的
// flush 信号（issue #14）。

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionRecord } from '@/lib/persistence/db';
import type { ModelIdentity, ThinkingLevel } from '@/lib/persistence/storage';
import type { Attachment } from '@/lib/agent/attachments';
import type { RecordedSession } from '@/lib/recorder/types';
import type { MCPResourceContents } from '@/lib/mcp/client';
import type { PermissionRequest } from '@/lib/agent/tool-permissions';
import type { BranchEntryInfo } from '@/lib/agent/session-projection';

// ─── Port name ───

/**
 * UI 实例 ↔ background 的长连接端口名。
 *
 * 按**端点**命名而非按载荷命名：这条连接同时承载会话、录制、记忆整理、MCP
 * 资源四个域，叫 "agent" 只说中其中一个。与同文件的 ClientMessage / ServerMessage
 * 共用一套词汇。
 *
 * 同名不等于同一条：`chrome.runtime.connect` 每次调用都新建一个 Port，name 仅供
 * 接收端辨认。复用靠调用方自己共享同一个 Port 对象。
 */
export const CLIENT_PORT = 'cebian-client';

/**
 * 一次发送 / 重试所携带的「本轮要用的模型 + 思考档」。属于该会话的选择，由发起的
 * sidepanel 随 prompt / retry 消息带给后台（而非后台读全局）。两字段都可选：缺省时
 * 后台回退到会话行 / 全局种子（向后兼容）。prompt / retry 协议消息与 session-manager
 * 的 override 参数、hook 的 turn 参数共用此形状，避免一个概念多份近似类型。
 */
export interface TurnSettings {
  model?: ModelIdentity;
  thinkingLevel?: ThinkingLevel;
}

// ─── Client → Background (requests) ───

export type ClientMessage =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe' }
  /** 发送一条用户消息。`model` / `thinkingLevel`（见 TurnSettings）是「本次发送所用的
   *  模型 / 思考档」，由发起的 sidepanel 随消息携带（而非后台读全局），属于该会话的
   *  选择。新会话据此建行；已有会话据此就地刷新活 agent 并落库到会话行（会话行是真相）。
   *  缺省时后台回退到全局 lastSelectedModel 充当「新对话默认种子」（向后兼容）。 */
  | ({ type: 'prompt'; sessionId: string | null; text: string; attachments?: Attachment[] } & TurnSettings)
  | { type: 'cancel'; sessionId: string }
  /** Re-run the last user turn for `sessionId`. The background drops any
   *  trailing assistant / toolResult messages (typically a failed turn or
   *  one the user is unhappy with) and resumes the agent loop from the most
   *  recent user message. No-op if no user message exists, or if the agent
   *  is currently running.
   *
   *  `model` / `thinkingLevel`（见 TurnSettings）同 prompt：携带「重试这一轮要用的
   *  模型 / 思考档」，支持「换个更强的模型再重试」。缺省时保持会话当前选择不变。
   *
   *  `entryId`（可选）：要重试的那一轮的 **user 消息** entry id——支持从历史任意
   *  一轮重新生成（旧回复留在分支上）。缺省时沿用旧语义：重试最后一轮。 */
  | ({ type: 'retry'; sessionId: string; entryId?: string } & TurnSettings)
  /** 编辑一条已发送的 user 消息并从该点重新生成（issue #44）。`entryId` 是目标
   *  消息的树 entry id（随广播的 BroadcastMessage 下发；未落树的乐观消息没有，
   *  UI 不给它显示编辑入口）。语义 = 回卷到该消息之前 + 以新文案重发：原分支
   *  完整保留为 sibling。`model` / `thinkingLevel` 同 prompt / retry。 */
  | ({ type: 'edit_message'; sessionId: string; entryId: string; text: string } & TurnSettings)
  /** 切换到某个分支：`targetEntryId` 是分支点上的目标兄弟 entry（取自
   *  `branchInfo[...].siblings`）。后台把 main lane 移到该兄弟子树的最深叶并
   *  重投影广播。仅 agent 空闲时受理。 */
  | { type: 'switch_branch'; sessionId: string; targetEntryId: string }
  | { type: 'resolve_tool'; sessionId: string; toolName: string; response: any }
  | { type: 'cancel_tool'; sessionId: string; toolName: string }
  /** User's decision on a tool's pre-execution permission prompt, keyed by
   *  `toolCallId`. Only the three explicit allow/deny choices travel here;
   *  an implicit "dismissed" (the user sent a new message instead) is handled
   *  by the existing steer/cancel path, not this message. */
  | { type: 'resolve_permission'; sessionId: string; toolCallId: string; decision: 'once' | 'always' | 'denied' }
  | { type: 'session_list' }
  | { type: 'session_delete'; sessionId: string }
  | { type: 'recorder_start' }
  | { type: 'recorder_stop' }
  /** Sent by a sidepanel right after it opens a port, declaring a unique
   *  per-instance id (generated client-side at module load via
   *  `crypto.randomUUID`). Used by the recorder to gate which port may
   *  stop the active recording and to detect that the initiator instance
   *  has gone away (port disconnect). Robust across window drag (tab
   *  detach/attach) because the id travels with the runtime, not the
   *  window. */
  | { type: 'hello'; instanceId: string }
  /** Read an MCP `ui://...` resource for rendering an MCP App iframe.
   *  Returns via `mcp_resource_result` matched on `requestId`. The reply
   *  is sent only to the requesting port, not broadcast — each chat
   *  message renders its own iframe and tracks its own pending read. */
  | { type: 'mcp_read_resource'; requestId: string; serverId: string; uri: string }
  /** 手动触发一次跨对话记忆整理。后台跨同时只跑一个（单飞行）；进度由
   *  `memory_organize_state` 广播，结果（diff/摘要）写入 memoryOrganizeState 供 UI 响应式读取。 */
  | { type: 'memory_organize' }
  /** 查当前是否正在整理（供设置页重新挂载时恢复「整理中」指示——切 tab 再切回不丢状态）。
   *  后台仅向发起端口回一条 `memory_organize_state`（不带 outcome，不触发 toast）。 */
  | { type: 'memory_organize_query' };

/**
 * `ClientMessage['type']` 的值级清单，供运行期穷尽性检查用（类型在编译后被擦除，
 * background 的 client-router 穷尽性测试需要一份可枚举的值）。
 *
 * 与联合类型的双向同步由编译期保证：多写 / 写错由 `satisfies` 报错，漏写由下方
 * `_AssertClientMessageTypesComplete` 报错（报错信息里会直接列出漏掉的类型名）。
 */
export const CLIENT_MESSAGE_TYPES = [
  'subscribe',
  'unsubscribe',
  'prompt',
  'cancel',
  'retry',
  'edit_message',
  'resolve_tool',
  'cancel_tool',
  'resolve_permission',
  'switch_branch',
  'session_list',
  'session_delete',
  'recorder_start',
  'recorder_stop',
  'hello',
  'mcp_read_resource',
  'memory_organize',
  'memory_organize_query',
] as const satisfies readonly ClientMessage['type'][];

type _ExpectNever<T extends never> = T;
// ClientMessage 新增类型而清单没跟上时，这行 tsc 红，报错里直接列出漏掉的类型名。
// 纯类型层，无运行时代码。
type _AssertClientMessageTypesComplete = _ExpectNever<
  Exclude<ClientMessage['type'], (typeof CLIENT_MESSAGE_TYPES)[number]>
>;

// ─── Background → Client (events) ───

/** 广播的消息形态：AgentMessage + 其树 entry id。id 供「按消息定位树操作」
 *  （消息编辑、将来的分支导航）使用；未落树的消息（乐观插入 / 流式中）没有 id，
 *  UI 据此隐藏编辑入口。注意 id 只存在于 IPC 副本上——background 的
 *  `agent.state.messages` 保持干净，否则 id 会被 syncTail 冻进树里。 */
export type BroadcastMessage = AgentMessage & { entryId?: string };

/** 流式复制操作：`stream_ops` 帧的最小增量单元，tail 指正在流式生成的
 *  assistant 尾消息。生产端见 entrypoints/background/chat/stream-broadcast.ts
 *  （从 pi 的 delta 事件构造并按时间窗合并），应用端见
 *  lib/agent/stream-replica.ts。副本的任何漂移都会在 message_end / agent_end
 *  的全量 transcript 边界被校正，本操作流只需覆盖两个边界之间的增量。 */
export type StreamOp =
  /** 内容块结构变化（块开始/结束等低频事件）：用快照整体替换（或追加）尾消息 */
  | { kind: 'tail_replace'; message: AgentMessage }
  /** 向尾消息第 blockIndex 个内容块的字段追加文本增量。text / thinking 直接
   *  追加；partialJson 追加后由应用端重新解析出 toolCall 的 arguments */
  | {
      kind: 'tail_append';
      blockIndex: number;
      field: 'text' | 'thinking' | 'partialJson';
      delta: string;
    };

/** 一个分支点的信息（定义与构建见 lib/agent/session-projection.ts 的
 *  buildBranchInfo）。键是当前分支上 entry 的 id，仅含兄弟数 ≥2 的分支点（稀疏）。 */
export type { BranchEntryInfo } from '@/lib/agent/session-projection';

/** `session_loaded` 携带的会话快照：会话行字段 + 带 entryId 标注的 transcript +
 *  分支点信息。 */
export type SessionSnapshot = Omit<SessionRecord, 'messages'> & {
  messages: BroadcastMessage[];
  branchInfo?: Record<string, BranchEntryInfo>;
};

/** Session metadata without messages, for listing. */
export type SessionMeta = Omit<SessionRecord, 'messages'> & {
  /** True iff the agent is currently running for this session in the
   * background. Populated by the background's `session_list` handler;
   * undefined when reading SessionRecord directly from Dexie. */
  isRunning?: boolean;
};

export type ServerMessage =
  | { type: 'connected' }
  | {
      type: 'session_state';
      sessionId: string;
      title?: string;
      /** 会话所用的 provider / model / 思考档。与 `title` 同语义：仅在首次订阅时
       *  （从 DB 行读出）携带，供 sidepanel 回填本地的 turn 草稿；mid-stream 的
       *  rebuild 广播一律省略，避免覆盖用户在途切换的选择。 */
      provider?: string;
      model?: string;
      thinkingLevel?: string;
      messages: BroadcastMessage[];
      isRunning: boolean;
      /** 是否正处于发送前的上下文压缩步骤（状态层正在生成并插入摘要）。
       *  为 true 时 sidepanel 显示「压缩中」指示，区别于普通的思考态。
       *  其余广播一律缺省 / false；hook 在 `agent_start` / `agent_end` /
       *  `error` 时清掉它。 */
      isCompacting?: boolean;
      pendingTools?: { toolName: string; toolCallId: string; args: any }[];
      /** Snapshot of in-flight permission prompts (a tool is paused in its
       *  `beforeToolCall` gate awaiting the user). Drives reconnect/restore
       *  of the prompt card, and lets the UI mark a persisted permissionRequest
       *  message as "expired" when its toolCallId is absent here. */
      pendingPermissions?: PermissionRequest[];
      /** 分支点信息（稀疏，仅兄弟数 ≥2 的 entry）。只在「分支结构可能变化」的
       *  帧携带（订阅快照 / 切换分支后）；缺省表示「维持上一帧的值」，前端不清空。 */
      branchInfo?: Record<string, BranchEntryInfo>;
    }
  | { type: 'agent_start'; sessionId: string }
  /** 两个全量边界（session_state / message_end / agent_end）之间的流式增量帧
   *  （一次合并窗内的操作序列，按序应用）。应用失败说明副本漂移，订阅方应
   *  重发 subscribe 拉取权威快照；对着过期副本应用产生的短暂错乱也会被下一
   *  个全量边界整体校正。 */
  | { type: 'stream_ops'; sessionId: string; ops: StreamOp[] }
  | { type: 'message_end'; sessionId: string; messages: BroadcastMessage[] }
  | {
      type: 'agent_end';
      sessionId: string;
      messages: BroadcastMessage[];
      /** 同 session_state.branchInfo：一轮结束（retry / 编辑可能刚造出新分支）时
       *  携带最新分支结构。 */
      branchInfo?: Record<string, BranchEntryInfo>;
    }
  | { type: 'error'; sessionId: string | null; error: string }
  | { type: 'tool_pending'; sessionId: string; toolName: string; toolCallId: string; args: any }
  | { type: 'tool_resolved'; sessionId: string; toolName: string }
  | { type: 'session_loaded'; sessionId: string; session: SessionSnapshot | null }
  | { type: 'session_list_result'; sessions: SessionMeta[] }
  | { type: 'session_deleted'; sessionId: string }
  | { type: 'session_created'; sessionId: string; title: string }
  | { type: 'recorder_status'; isRecording: boolean; startedAt: number | null; eventCount: number; truncated?: 'event_limit' | 'time_limit'; initiatorInstanceId: string | null; activeWindowId: number | null }
  | { type: 'recorder_session'; session: RecordedSession }
  /** Sent in reply to `recorder_start` when the BG refuses to start a
   *  recording. `busy` = another sidepanel instance currently owns the
   *  recorder; `before_hello` = the requesting port never sent its
   *  `instanceId`. The sidepanel toasts this rather than disabling the
   *  button up front, so the click is never confusingly silent. */
  | { type: 'recorder_start_rejected'; reason: 'busy' | 'before_hello' }
  /** Response to `mcp_read_resource`. `result` carries the full resource
   *  payload including `_meta.ui` (CSP / permissions for sandboxing).
   *  Error codes:
   *  - `server_unavailable`: MCP server not registered or user-disabled —
   *    surface a "this diagram can't be loaded" UI with a hint to re-enable.
   *  - `fetch_failed`: connection, throttle, parse, or any other runtime
   *    failure — surface the message and offer a retry. */
  | {
      type: 'mcp_resource_result';
      requestId: string;
      result?: MCPResourceContents;
      error?: { code: 'server_unavailable' | 'fetch_failed'; message: string };
    }
  /** 记忆整理的运行态（全局、非会话维度）。running 驱动设置页「整理中…」指示；
   *  结束时携 outcome 供 UI toast 反馈（空转/冲突/失败等）；error 在出错时携一句话说明。
   *  结果详情（diff/摘要）走 memoryOrganizeState。 */
  | {
      type: 'memory_organize_state';
      running: boolean;
      outcome?: 'ok' | 'empty' | 'conflict' | 'rejected' | 'failed' | 'no-model';
      error?: string;
    };

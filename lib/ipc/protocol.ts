// Port communication protocol: Client (sidepanel) ↔ Server (background)

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionRecord } from '@/lib/persistence/db';
import type { ModelIdentity, ThinkingLevel } from '@/lib/persistence/storage';
import type { Attachment } from '@/lib/agent/attachments';
import type { RecordedSession } from '@/lib/recorder/types';
import type { MCPResourceContents } from '@/lib/mcp/client';
import type { PermissionRequest } from '@/lib/agent/tool-permissions';

// ─── Port name ───

export const AGENT_PORT_NAME = 'cebian-agent';

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
   *  模型 / 思考档」，支持「换个更强的模型再重试」。缺省时保持会话当前选择不变。 */
  | ({ type: 'retry'; sessionId: string } & TurnSettings)
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

// ─── Background → Client (events) ───

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
      messages: AgentMessage[];
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
    }
  | { type: 'agent_start'; sessionId: string }
  | { type: 'message_update'; sessionId: string; message: AgentMessage }
  | { type: 'message_end'; sessionId: string; messages: AgentMessage[] }
  | { type: 'agent_end'; sessionId: string; messages: AgentMessage[] }
  | { type: 'error'; sessionId: string | null; error: string }
  | { type: 'tool_pending'; sessionId: string; toolName: string; toolCallId: string; args: any }
  | { type: 'tool_resolved'; sessionId: string; toolName: string }
  | { type: 'session_loaded'; sessionId: string; session: SessionRecord | null }
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

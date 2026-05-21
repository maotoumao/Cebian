// Port communication protocol: Client (sidepanel) ↔ Server (background)

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { SessionRecord } from './db';
import type { Attachment } from './attachments';
import type { RecordedSession } from './recorder/types';
import type { MCPResourceContents } from './mcp/client';

// ─── Port name ───

export const AGENT_PORT_NAME = 'cebian-agent';

// ─── Client → Background (requests) ───

export type ClientMessage =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe' }
  | { type: 'prompt'; sessionId: string | null; text: string; attachments?: Attachment[] }
  | { type: 'cancel'; sessionId: string }
  /** Re-run the last user turn for `sessionId`. The background drops any
   *  trailing assistant / toolResult messages (typically a failed turn or
   *  one the user is unhappy with) and resumes the agent loop from the most
   *  recent user message. No-op if no user message exists, or if the agent
   *  is currently running. */
  | { type: 'retry'; sessionId: string }
  | { type: 'resolve_tool'; sessionId: string; toolName: string; response: any }
  | { type: 'cancel_tool'; sessionId: string; toolName: string }
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
  | { type: 'mcp_read_resource'; requestId: string; serverId: string; uri: string };

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
  | { type: 'session_state'; sessionId: string; title?: string; messages: AgentMessage[]; isRunning: boolean }
  | { type: 'agent_start'; sessionId: string }
  | { type: 'message_update'; sessionId: string; message: AgentMessage }
  | { type: 'message_end'; sessionId: string; messages: AgentMessage[] }
  | { type: 'agent_end'; sessionId: string; messages: AgentMessage[] }
  | { type: 'error'; sessionId: string | null; error: string }
  | { type: 'tool_pending'; sessionId: string; toolName: string; toolCallId: string; args: any }
  | { type: 'tool_resolved'; sessionId: string; toolName: string }
  | { type: 'session_loaded'; session: SessionRecord | null }
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
    };

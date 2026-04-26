// Port communication protocol: Client (sidepanel) ↔ Server (background)

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { SessionRecord } from './db';
import type { Attachment } from './attachments';
import type { RecordedSession } from './recorder/types';

// ─── Port name ───

export const AGENT_PORT_NAME = 'cebian-agent';

// ─── Client → Background (requests) ───

export type ClientMessage =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe' }
  | { type: 'prompt'; sessionId: string | null; text: string; attachments?: Attachment[] }
  | { type: 'cancel'; sessionId: string }
  | { type: 'resolve_tool'; sessionId: string; toolName: string; response: any }
  | { type: 'cancel_tool'; sessionId: string; toolName: string }
  | { type: 'session_load'; sessionId: string }
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
  | { type: 'hello'; instanceId: string };

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
  | { type: 'session_state'; sessionId: string; messages: AgentMessage[]; isRunning: boolean }
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
  | { type: 'recorder_start_rejected'; reason: 'busy' | 'before_hello' };

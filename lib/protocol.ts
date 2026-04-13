// Port communication protocol: Client (sidepanel) ↔ Server (background)

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
  | { type: 'cancel'; sessionId: string }
  | { type: 'resolve_tool'; sessionId: string; toolName: string; response: any }
  | { type: 'cancel_tool'; sessionId: string; toolName: string }
  | { type: 'session_load'; sessionId: string }
  | { type: 'session_list' }
  | { type: 'session_delete'; sessionId: string };

// ─── Background → Client (events) ───

/** Session metadata without messages, for listing. */
export type SessionMeta = Omit<SessionRecord, 'messages'>;

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
  | { type: 'session_created'; sessionId: string; title: string };

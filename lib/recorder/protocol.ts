// Message envelopes for the recorder.
//
// Two channels:
//   1. Content script ↔ background: chrome.runtime.sendMessage with the
//      `RecorderRuntimeMessage` shapes below. The background filters by
//      `kind === 'cebian_recorder'` to ignore unrelated runtime messages.
//   2. Sidepanel ↔ background: piggybacks on the existing AGENT_PORT_NAME
//      via the new variants added to `lib/protocol.ts`.

import type { RecordedEventWithoutBase } from './types';

/** Tag every recorder runtime message so we don't accidentally pick up
 *  unrelated chrome.runtime traffic. */
export const RECORDER_MSG_KIND = 'cebian_recorder' as const;

// ─── Background → Content script ───

/** Sent right after injection so the content script knows the time origin
 *  and its own tabId (content scripts have no way to discover their own
 *  tabId; the background tells them so each emitted event can stamp it). */
export type RecorderInitMessage = {
  kind: typeof RECORDER_MSG_KIND;
  type: 'init';
  /** Absolute timestamp (Date.now) at session start; `t` is computed against this. */
  startedAt: number;
  /** Tab id the content script is running in. */
  tabId: number;
};

/** Sent during graceful detach to flush the last mutation buffer. */
export type RecorderFinalFlushMessage = {
  kind: typeof RECORDER_MSG_KIND;
  type: 'final_flush';
};

export type RecorderControlMessage =
  | RecorderInitMessage
  | RecorderFinalFlushMessage;

// ─── Content script → Background ───

/** A single event captured in the page. The content script omits `id` and
 *  `t` — the background assigns both on receipt so timestamps reflect a
 *  single monotonic clock and ids are guaranteed unique within the session. */
export type RecorderEventMessage = {
  kind: typeof RECORDER_MSG_KIND;
  type: 'event';
  event: RecordedEventWithoutBase;
};

export type RecorderRuntimeMessage =
  | RecorderControlMessage
  | RecorderEventMessage;

/** Type guard for runtime listeners. */
export function isRecorderRuntimeMessage(msg: unknown): msg is RecorderRuntimeMessage {
  return (
    typeof msg === 'object'
    && msg !== null
    && (msg as { kind?: unknown }).kind === RECORDER_MSG_KIND
  );
}

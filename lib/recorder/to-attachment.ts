// Convert a captured RecordedSession into a RecordingAttachment, applying
// the size cap with end-truncation of the events array.
//
// The wire format (JSON serialized into the attachment) is a compacted
// projection of `RecordedSession` — see `buildWire` below — designed to
// minimize agent token cost. Internal sidepanel/channel code keeps using
// the original `RecordedSession` shape; only the JSON the agent reads
// goes through compaction.

import type { RecordedEvent, RecordedSession } from './types';
import {
  MAX_RECORDING_SIZE,
  type RecordingAttachment,
} from '@/lib/attachments';
import { randomId } from '@/lib/utils';

/** Pad number to 2 digits. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Filename pattern: `recording-YYYYMMDD-HHmmss-XXXX.json` (local time + random). */
function recordingFileName(startedAt: number): string {
  const d = new Date(startedAt);
  const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `recording-${date}-${time}-${randomId(4, 16)}.json`;
}

/** UTF-8 byte length without allocating a Blob. */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Recursively drop empty strings, `undefined`, and `null` from a value.
 *  Preserves `0`, `false`, and other meaningful falsy values. Arrays of
 *  objects are recursed element-wise; primitive arrays pass through
 *  unchanged. Returns `undefined` if the value itself is empty so callers
 *  can drop it from a parent object. */
function stripEmpty(v: unknown): unknown {
  if (v === '' || v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    return v.map(stripEmpty).filter(x => x !== undefined);
  }
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      const cleaned = stripEmpty((v as Record<string, unknown>)[k]);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return v;
}

/** Project a session into the compact wire shape:
 *
 *  - top-level `tabs: number[]` — Chrome tabIds in first-seen order
 *  - each event base shrinks to `{ id, t, tIdx, kind }` (tabId/url removed)
 *  - tab events keep their own `url` since there it represents a
 *    navigation / focus state change rather than ambient context
 *  - empty strings, undefined, and null are dropped throughout
 *
 *  Token impact: each event saves ~tabId(~10) + url(~50-150) chars; the
 *  tabs[] table costs O(unique-tabs) ints. Net savings scale with event
 *  count, dominated by URL length. */
function buildWire(session: RecordedSession, events: RecordedEvent[]): unknown {
  const tabs: number[] = [];
  const tabIdx = new Map<number, number>();

  const wireEvents = events.map(e => {
    let idx = tabIdx.get(e.tabId);
    if (idx === undefined) {
      idx = tabs.length;
      tabs.push(e.tabId);
      tabIdx.set(e.tabId, idx);
    }
    // Strip tabId/url from the base; reattach url ONLY for tab events
    // (where it carries the new URL of a navigation/focus_changed/etc).
    const { tabId: _tabId, url, ...rest } = e;
    const wire: Record<string, unknown> = { ...rest, tIdx: idx };
    if (e.kind === 'tab' && url) wire.url = url;
    return wire;
  });

  return stripEmpty({
    version: session.version,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    durationMs: session.durationMs,
    windowId: session.windowId,
    tabs,
    events: wireEvents,
    truncated: session.truncated,
  });
}

/**
 * Convert a `RecordedSession` into a `RecordingAttachment`. If the serialized
 * JSON exceeds `MAX_RECORDING_SIZE` bytes, events are dropped from the end
 * by repeatedly cutting in proportion to the overflow until it fits. In
 * practice one or two iterations is enough since event sizes are roughly
 * uniform within a session.
 *
 * Compaction (`buildWire`) runs each iteration so the `tabs[]` table stays
 * minimal — tabs only referenced by trimmed-off late events disappear.
 */
export function recordingToAttachment(session: RecordedSession): RecordingAttachment {
  const name = recordingFileName(session.startedAt);
  let events = session.events;
  let json = JSON.stringify(buildWire(session, events));
  let sizeBytes = utf8ByteLength(json);
  let truncatedAttachment = false;

  while (sizeBytes > MAX_RECORDING_SIZE && events.length > 0) {
    // Cut in proportion to overflow. Floor of (length * ratio<1) is already
    // strictly less than length, but guard against FP edge cases by forcing
    // at least one event off if the floor didn't shrink.
    const ratio = MAX_RECORDING_SIZE / sizeBytes;
    let newCount = Math.floor(events.length * ratio);
    if (newCount >= events.length) newCount = events.length - 1;
    events = events.slice(0, newCount);
    json = JSON.stringify(buildWire(session, events));
    sizeBytes = utf8ByteLength(json);
    truncatedAttachment = true;
  }

  return {
    type: 'recording',
    name,
    sizeBytes,
    eventCount: events.length,
    durationMs: session.durationMs,
    json,
    ...(truncatedAttachment ? { truncatedAttachment: true as const } : {}),
  };
}

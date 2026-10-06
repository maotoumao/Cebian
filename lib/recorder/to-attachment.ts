// Convert a captured RecordedSession into a RecordingAttachment, applying
// the size cap（超限时分级降级，见 recordingToAttachment）。
//
// The wire format (JSON serialized into the attachment) is a compacted
// projection of `RecordedSession` — see `buildWire` below — designed to
// minimize agent token cost. Internal sidepanel/channel code keeps using
// the original `RecordedSession` shape; only the JSON the agent reads
// goes through compaction.
//
// 开了网络录制时，网络请求以紧凑条目（见 network-summary.ts）并入同一条时间线；完整数据另外
// 生成 HAR，发送时由后台写进会话工作目录（附件只带着它过去，不进内联 JSON）。

import { browser } from 'wxt/browser';
import type { RecordedEvent, RecordedSession } from './types';
import { buildHar } from './har';
import { summarizeNetworkEntry, type NetworkEvent } from './network-summary';
import {
  MAX_RECORDING_SIZE,
  type RecordingAttachment,
} from '@/lib/agent/attachments';
import { randomId } from '@/lib/utils';

/** 时间线上的一项：操作 / 标签页 / 结构变化事件，或网络请求条目。 */
type TimelineEvent = RecordedEvent | NetworkEvent;

/**
 * 内联 JSON 超过上限时的降级档位：先去掉网络条目的结构概要，再去掉请求 / 响应预览（HAR 里
 * 都有），最后才从末尾截掉事件。
 */
type NetworkDetail = 'full' | 'no_shape' | 'no_previews';

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

/** 按 `t` 稳定合并两条已各自排好序的时间线。 */
function mergeTimeline(events: RecordedEvent[], network: NetworkEvent[]): TimelineEvent[] {
  const merged: TimelineEvent[] = [];
  let i = 0;
  let j = 0;
  while (i < events.length || j < network.length) {
    if (j >= network.length || (i < events.length && events[i].t <= network[j].t)) merged.push(events[i++]);
    else merged.push(network[j++]);
  }
  return merged;
}

/** 网络录制的整体情况（放在内联 JSON 顶层，HAR 里另有完整记录）。 */
function networkSummary(session: RecordedSession, included: number, detail: NetworkDetail): unknown {
  const log = session.network;
  if (!log) return undefined;
  return {
    state: log.state,
    requests: log.entries.length,
    // 内联时间线里实际带上的条数（体积超限从末尾截掉事件时会少于 requests）
    included: included === log.entries.length ? undefined : included,
    filtered: log.filteredCount,
    truncated: log.truncated,
    abortedAt: log.abortedAt,
    unavailableReason: log.unavailableReason,
    unavailableTabs: log.unavailableTabs?.length,
    previews: detail === 'full' ? undefined : detail,
  };
}

function wireNetworkEvent(event: NetworkEvent, detail: NetworkDetail): Record<string, unknown> {
  const { tabId: _tabId, ...rest } = event;
  const wire: Record<string, unknown> = { ...rest };
  if (detail !== 'full') delete wire.shape;
  if (detail === 'no_previews') {
    delete wire.req;
    delete wire.res;
  }
  return wire;
}

/** Project a session into the compact wire shape:
 *
 *  - top-level `tabs: number[]` — Chrome tabIds in first-seen order
 *  - each event base shrinks to `{ id, t, tIdx, kind }` (tabId/url removed)
 *  - tab events keep their own `url` since there it represents a
 *    navigation / focus state change rather than ambient context
 *  - 网络条目保留自己的 `url`（请求地址，不是所在页面）
 *  - empty strings, undefined, and null are dropped throughout
 *
 *  Token impact: each event saves ~tabId(~10) + url(~50-150) chars; the
 *  tabs[] table costs O(unique-tabs) ints. Net savings scale with event
 *  count, dominated by URL length. */
function buildWire(session: RecordedSession, events: TimelineEvent[], detail: NetworkDetail): unknown {
  const tabs: number[] = [];
  const tabIdx = new Map<number, number>();
  let networkIncluded = 0;

  const wireEvents = events.map(e => {
    let idx = tabIdx.get(e.tabId);
    if (idx === undefined) {
      idx = tabs.length;
      tabs.push(e.tabId);
      tabIdx.set(e.tabId, idx);
    }
    if (e.kind === 'network') {
      networkIncluded += 1;
      return { ...wireNetworkEvent(e, detail), tIdx: idx };
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
    network: networkSummary(session, networkIncluded, detail),
  });
}

/**
 * 把 `RecordedSession` 转成 `RecordingAttachment`。序列化后的 JSON 超过
 * `MAX_RECORDING_SIZE` 字节时逐级降级：先去掉网络条目的响应结构概要，再去掉请求 / 响应
 * 预览（HAR 里都有），最后才按超出比例从末尾截掉事件，直到放得下。
 *
 * 每轮都重新 `buildWire`，让 `tabs[]` 表保持最小——只被截掉的末尾事件引用的标签页随之消失。
 * 录到了请求时另外生成 HAR 随附件带着（不进内联 JSON）。
 */
export function recordingToAttachment(session: RecordedSession): RecordingAttachment {
  const name = recordingFileName(session.startedAt);
  const networkEvents = (session.network?.entries ?? []).map(summarizeNetworkEntry);
  let events = mergeTimeline(session.events, networkEvents);

  let detail: NetworkDetail = 'full';
  let json = JSON.stringify(buildWire(session, events, detail));
  let sizeBytes = utf8ByteLength(json);
  for (const next of ['no_shape', 'no_previews'] as const) {
    if (sizeBytes <= MAX_RECORDING_SIZE || networkEvents.length === 0) break;
    detail = next;
    json = JSON.stringify(buildWire(session, events, detail));
    sizeBytes = utf8ByteLength(json);
  }

  let truncatedAttachment = false;
  while (sizeBytes > MAX_RECORDING_SIZE && events.length > 0) {
    // Cut in proportion to overflow. Floor of (length * ratio<1) is already
    // strictly less than length, but guard against FP edge cases by forcing
    // at least one event off if the floor didn't shrink.
    const ratio = MAX_RECORDING_SIZE / sizeBytes;
    let newCount = Math.floor(events.length * ratio);
    if (newCount >= events.length) newCount = events.length - 1;
    events = events.slice(0, newCount);
    json = JSON.stringify(buildWire(session, events, detail));
    sizeBytes = utf8ByteLength(json);
    truncatedAttachment = true;
  }

  const networkCount = events.filter((e) => e.kind === 'network').length;
  const network = session.network;
  return {
    type: 'recording',
    name,
    sizeBytes,
    eventCount: events.length - networkCount,
    durationMs: session.durationMs,
    json,
    ...(truncatedAttachment ? { truncatedAttachment: true as const } : {}),
    ...(network ? {
      networkCount,
      filteredCount: network.filteredCount,
      networkState: network.state,
    } : {}),
    // 一条请求都没录到（如网络录制不可用）时不生成空 HAR
    ...(network && network.entries.length > 0 ? {
      har: {
        name: name.replace(/\.json$/, '.har'),
        json: buildHar(network, session.startedAt, browser.runtime.getManifest().version),
      },
    } : {}),
  };
}

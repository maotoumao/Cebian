// 网络请求在内联时间线里的紧凑形式：每个请求一行，给模型看「点了什么 → 发了什么请求、
// 拿到了什么」；完整的请求头、请求体、响应体在 HAR 文件里，按 `id`（即 HAR 的 `_cebianId`）定位。

import type { NetworkEntry } from './network-types';
import { ANTI_HIJACK_PREFIX } from './redact-values';
import { oneLine, truncate } from '@/lib/utils';
import {
  NETWORK_REQUEST_PREVIEW_MAX,
  NETWORK_RESPONSE_PREVIEW_MAX,
  NETWORK_SHAPE_MAX,
} from './constants';

/**
 * 一行一个请求的内联条目，与操作事件（InteractionEvent / TabEvent / MutationEvent）同处
 * 一条时间线、按 `t` 排序。注意 `url` 是请求地址：组装时间线时不能像操作事件那样把它当成
 * 「所在页面地址」去掉。
 */
interface NetworkEvent {
  kind: 'network';
  id: string;
  t: number;
  tabId: number;
  type: NetworkEntry['type'];
  method: string;
  url: string;
  status?: number;
  ms?: number;
  error?: string;
  /** 经过的重定向次数。 */
  redirects?: number;
  /** 请求体预览。 */
  req?: string;
  /** 请求体没有录到的原因。 */
  reqOmitted?: string;
  /** 响应体预览。 */
  res?: string;
  /** JSON 响应的结构概要（字段名与类型）。 */
  shape?: string;
  /** 响应体没有录到的原因。 */
  resOmitted?: string;
  /** WebSocket / EventSource 录到的消息条数。 */
  messages?: number;
}

function preview(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const flat = oneLine(text);
  return flat ? truncate(flat, max) : undefined;
}

const SHAPE_MAX_DEPTH = 4;
const SHAPE_MAX_KEYS = 20;

function shapeOf(value: unknown, depth: number): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (depth >= SHAPE_MAX_DEPTH) return '[…]';
    return `[${shapeOf(value[0], depth + 1)}]`;
  }
  if (typeof value === 'object') {
    if (depth >= SHAPE_MAX_DEPTH) return '{…}';
    const entries = Object.entries(value as Record<string, unknown>);
    const parts = entries.slice(0, SHAPE_MAX_KEYS).map(([key, child]) => `${key}:${shapeOf(child, depth + 1)}`);
    if (entries.length > SHAPE_MAX_KEYS) parts.push('…');
    return `{${parts.join(',')}}`;
  }
  return typeof value;
}

/**
 * JSON 文本的结构概要，如 `{id:number,items:[{name:string,price:number}],next:null}`：
 * 数组只看首个元素，深度与每层字段数有上限，整体超长时截断。不是 JSON 时返回 undefined。
 */
function jsonShape(text: string | undefined): string | undefined {
  if (!text) return undefined;
  // 去掉 Google 等站点的 JSON 防劫持前缀（`)]}'`）
  const body = text.slice(ANTI_HIJACK_PREFIX.exec(text)?.[0].length ?? 0);
  const trimmed = body.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  return truncate(shapeOf(value, 0), NETWORK_SHAPE_MAX);
}

function summarizeNetworkEntry(entry: NetworkEntry): NetworkEvent {
  const responseText = entry.responseBody?.text;
  return {
    kind: 'network',
    id: entry.id,
    t: entry.t,
    tabId: entry.tabId,
    type: entry.type,
    method: entry.method,
    url: entry.url,
    status: entry.status,
    ms: entry.durationMs,
    error: entry.error,
    redirects: entry.redirects?.length || undefined,
    req: preview(entry.requestBody?.text, NETWORK_REQUEST_PREVIEW_MAX),
    reqOmitted: entry.requestBody?.omitted,
    res: preview(responseText, NETWORK_RESPONSE_PREVIEW_MAX),
    shape: jsonShape(responseText),
    resOmitted: entry.responseBody?.omitted,
    messages: entry.messages?.length,
  };
}

// ─── 公开 API ───

export { jsonShape, summarizeNetworkEntry, type NetworkEvent };

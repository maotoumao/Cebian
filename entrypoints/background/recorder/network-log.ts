// 网络录制的累积器：Chrome（CDP）与 Firefox（webRequest）两种采集方式共用。
//
// 负责「录不录、录多少」：类型与埋点过滤、条目与总量上限、请求 / 响应体的大小判断与打码。
// 打码在这里就地完成，原始敏感值不离开后台。总量按实际保存的内容（打码、截断之后）的
// UTF-8 字节数计算。

import { mediaType } from '@/lib/content/mime';
import {
  NETWORK_BODY_MAX,
  NETWORK_MAX_ENTRIES,
  NETWORK_STREAM_MESSAGE_CHARS,
  NETWORK_STREAM_MESSAGES_MAX,
  NETWORK_TOTAL_MAX,
} from '@/lib/recorder/constants';
import { isTelemetryRequest, isTextMimeType } from '@/lib/recorder/network-filter';
import type {
  NetworkBody,
  NetworkCaptureState,
  NetworkEntry,
  NetworkHeader,
  NetworkLog,
  NetworkResourceType,
} from '@/lib/recorder/network-types';
import { redactBody, redactHeaders, redactStreamData } from '@/lib/recorder/redact';
import { redactUrl } from '@/lib/recorder/redact-values';
import { randomId, truncate } from '@/lib/utils';
import { eventOffset } from './timeline';

/** 新请求的原始信息（未打码）。 */
interface NewRequest {
  tabId: number;
  type: NetworkResourceType;
  method: string;
  url: string;
  /** 请求发出的绝对时刻（ms）。 */
  at: number;
  headers: NetworkHeader[];
}

/** socket.io / engine.io 帧在 JSON 前面带数字包类型（`42["event",{…}]`），分开打码再拼回。 */
const PACKET_PREFIX = /^\d+(?=[[{])/;

const utf8 = new TextEncoder();

function byteLength(text: string): number {
  return utf8.encode(text).length;
}

/** WebSocket 帧：去掉 socket.io 前缀后按正文打码；格式无法可靠打码时返回 undefined。 */
function redactSocketFrame(data: string): string | undefined {
  const prefix = PACKET_PREFIX.exec(data)?.[0] ?? '';
  const redacted = redactBody(data.slice(prefix.length));
  return redacted === undefined ? undefined : prefix + redacted;
}

/** 正文是否按文本记录：文本类型，以及交给 multipart 打码规则逐字段处理的表单。 */
function isRecordableMime(mimeType: string): boolean {
  return isTextMimeType(mimeType) || mediaType(mimeType) === 'multipart/form-data';
}

class NetworkLogBuilder {
  private readonly startedAt: number;
  private readonly entries: NetworkEntry[] = [];
  private totalBytes = 0;
  private state: NetworkCaptureState = 'active';
  private abortedAt?: number;
  private unavailableReason?: string;
  private filteredCount = 0;
  private truncated?: NetworkLog['truncated'];
  private readonly unavailableTabs = new Map<number, string>();
  /** 是否成功连上过至少一个标签页（Chrome）或成功装上了监听（Firefox）。 */
  private attachedAny = false;

  constructor(startedAt: number) {
    this.startedAt = startedAt;
  }

  get count(): number {
    return this.entries.length;
  }

  /** 是否已被用户中止。 */
  get aborted(): boolean {
    return this.state === 'aborted';
  }

  /** 绝对时刻 → 相对录制开始的毫秒数（夹到录制区间内）。 */
  offset(at: number): number {
    return eventOffset(at, Date.now(), this.startedAt);
  }

  /** 是否还接受新请求：中止、不可用或到达上限后不再录。 */
  get accepting(): boolean {
    return this.state === 'active' && !this.truncated;
  }

  /**
   * 登记一个新请求。埋点请求计入过滤数，到达条目上限后停止录制网络；不录时返回 undefined。
   * URL 与请求头就地打码。
   */
  addRequest(request: NewRequest): NetworkEntry | undefined {
    if (!this.accepting) return undefined;
    if (isTelemetryRequest(request.url)) {
      this.filteredCount += 1;
      return undefined;
    }
    if (this.entries.length >= NETWORK_MAX_ENTRIES) {
      this.truncated = 'entry_limit';
      return undefined;
    }
    const entry: NetworkEntry = {
      id: randomId(6),
      t: this.offset(request.at),
      tabId: request.tabId,
      type: request.type,
      method: request.method,
      url: redactUrl(request.url),
      requestHeaders: redactHeaders(request.headers),
    };
    this.entries.push(entry);
    return entry;
  }

  /**
   * 生成请求体 / 响应体：非文本类型不记、超过单体上限不记、格式无法可靠打码的不记；记录的
   * 内容打码并按保存的字节数计入总量，总量超限时停止录制网络、这一份也不记。
   * `transferSize` 是已知的传输字节数（可能是压缩后的）。
   */
  body(text: string | undefined, mimeType: string | undefined, transferSize?: number): NetworkBody {
    const mime = mimeType || undefined;
    const sizes = transferSize != null ? { transferSize } : {};
    if (text == null) return { mimeType: mime, omitted: 'unavailable', ...sizes };
    const size = byteLength(text);
    if (mime && !isRecordableMime(mime)) return { mimeType: mime, omitted: 'binary', size, ...sizes };
    if (size > NETWORK_BODY_MAX) return { mimeType: mime, omitted: 'too_large', size, ...sizes };
    const redacted = redactBody(text, mime);
    // 格式无法可靠打码（HTML、XML、脚本、无结构文本等）：宁缺毋漏，不记
    if (redacted === undefined) return { mimeType: mime, omitted: 'unsupported', size, ...sizes };
    if (!this.charge(byteLength(redacted))) return { mimeType: mime, omitted: 'too_large', size, ...sizes };
    return { mimeType: mime, text: redacted, size, ...sizes };
  }

  /** 记录过的正文被替换或删除（如重定向后换成新一跳）：退回它占用的总量额度。 */
  discardBody(body: NetworkBody | undefined): void {
    if (body?.text != null) this.totalBytes = Math.max(0, this.totalBytes - byteLength(body.text));
  }

  /** 已知大小超过单体上限、不去读取的正文。 */
  tooLarge(mimeType: string | undefined, size: number | undefined, transferSize?: number): NetworkBody {
    return {
      mimeType: mimeType || undefined,
      omitted: 'too_large',
      ...(size != null ? { size } : {}),
      ...(transferSize != null ? { transferSize } : {}),
    };
  }

  /**
   * 响应体是否值得去取：可记录的类型、已知大小（解压后的、头部声明的或传输的，取最大）不超过
   * 单体上限、总量还有余量。不取时直接返回记录用的省略说明。
   */
  shouldFetchBody(mimeType: string | undefined, knownSize: number | undefined, transferSize?: number): NetworkBody | true {
    const sizes = transferSize != null ? { transferSize } : {};
    if (!mimeType || !isRecordableMime(mimeType)) return { mimeType, omitted: 'binary', ...sizes };
    if ((knownSize != null && knownSize > NETWORK_BODY_MAX) || this.truncated) {
      return this.tooLarge(mimeType, knownSize, transferSize);
    }
    return true;
  }

  /**
   * WebSocket 帧 / EventSource 消息预览：每个连接最多若干条；先打码再截断（截断后的 JSON 无法
   * 解析），格式无法可靠打码的只记占位；按保存的字节数计入总量。EventSource 的数据按 SSE
   * 规则打码（与 SSE 正文一致），WebSocket 帧按正文规则打码（兼容 socket.io 前缀）。
   */
  addMessage(entry: NetworkEntry, direction: 'sent' | 'received', at: number, data: string, binary = false): void {
    const messages = (entry.messages ??= []);
    if (messages.length >= NETWORK_STREAM_MESSAGES_MAX || this.truncated) {
      entry.messagesTruncated = true;
      return;
    }
    let redacted: string;
    if (binary) redacted = data;
    else if (data.length > NETWORK_BODY_MAX) redacted = '[not recorded: message too large]';
    else if (entry.type === 'eventsource') redacted = redactStreamData(data);
    else redacted = redactSocketFrame(data) ?? '[not recorded: unsupported format]';
    const clipped = truncate(redacted, NETWORK_STREAM_MESSAGE_CHARS);
    if (!this.charge(byteLength(clipped))) {
      entry.messagesTruncated = true;
      return;
    }
    messages.push({ direction, t: this.offset(at), data: clipped, ...(binary ? { binary: true as const } : {}) });
  }

  /** 用户中途中止了网络录制（Chrome 取消了调试提示条 / Firefox 撤销了权限）。 */
  abort(at: number): void {
    if (this.state !== 'active') return;
    this.state = 'aborted';
    this.abortedAt = this.offset(at);
  }

  /** 整次录制都无法录网络（如 Firefox 未授权）。 */
  markUnavailable(reason: string): void {
    this.unavailableReason ??= reason;
  }

  /** 某个标签页连不上（如被其它调试器占用）；其余标签页照常录。 */
  markTabUnavailable(tabId: number, reason: string): void {
    this.unavailableTabs.set(tabId, reason);
  }

  /** 成功连上了某个标签页 / 装上了监听。 */
  markAttached(tabId?: number): void {
    this.attachedAny = true;
    if (tabId != null) this.unavailableTabs.delete(tabId);
  }

  /** 当前状态：从没连上过、且有失败原因时为 unavailable。 */
  get liveState(): NetworkCaptureState {
    if (this.state !== 'active') return this.state;
    return !this.attachedAny && (this.unavailableReason || this.unavailableTabs.size) ? 'unavailable' : 'active';
  }

  toLog(): NetworkLog {
    const state = this.liveState;
    const reason = this.unavailableReason ?? this.unavailableTabs.values().next().value;
    const unavailableTabs = [...this.unavailableTabs].map(([tabId, tabReason]) => ({ tabId, reason: tabReason }));
    return {
      state,
      ...(this.abortedAt != null ? { abortedAt: this.abortedAt } : {}),
      ...(state === 'unavailable' && reason ? { unavailableReason: reason } : {}),
      ...(state !== 'unavailable' && unavailableTabs.length ? { unavailableTabs } : {}),
      // 复制条目：采集方在返回之后不会再改动，这里再隔离一层，保证交出去的是稳定快照
      entries: this.entries.map((entry) => structuredClone(entry)).sort((a, b) => a.t - b.t),
      filteredCount: this.filteredCount,
      ...(this.truncated ? { truncated: this.truncated } : {}),
    };
  }

  private charge(bytes: number): boolean {
    if (this.totalBytes + bytes > NETWORK_TOTAL_MAX) {
      this.truncated = 'size_limit';
      return false;
    }
    this.totalBytes += bytes;
    return true;
  }
}

// ─── 公开 API ───

export { NetworkLogBuilder, type NewRequest };

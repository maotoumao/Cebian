// Chrome：用 CDP Network 域旁观被跟踪标签页的网络请求（页面零改动）。
//
// 连接经 debugger-session 租用，每个访问过的 http(s) 标签页持有一份租约直到录制结束或
// 标签页关闭——切换焦点不释放，避免调试提示条反复出现、也保住后台标签页上还没取完的响应体。
// 只记录发生在「当前被跟踪的标签页」上、且该标签页当前是普通网页时发起的请求。不订阅
// `*ExtraInfo` 事件，Cookie 根本不采集。扩展自己的页面（含 Cebian 发给模型的请求）不录。

import { acquireDebugger, type DebuggerLease } from '@/lib/browser/debugger-session';
import { isInjectablePage } from '@/lib/browser/tab-actions';
import { fromCdpResourceType } from '@/lib/recorder/network-filter';
import type { NetworkEntry, NetworkLog } from '@/lib/recorder/network-types';
import { NETWORK_BODY_MAX } from '@/lib/recorder/constants';
import { contentLength, contentType, headerList } from '@/lib/recorder/network-headers';
import { redactHeaders } from '@/lib/recorder/redact';
import { redactUrl } from '@/lib/recorder/redact-values';
import { base64ToBytes } from '@/lib/utils';
import { NetworkLogBuilder } from './network-log';

/** 停止时等待未取完的请求 / 响应体的最长时间。 */
const STOP_DRAIN_MS = 1500;
/** 浏览器为 getResponseBody 保留的缓冲：单个资源要大于单体上限，否则大一些的 JSON 会被提前丢掉。 */
const RESOURCE_BUFFER_BYTES = NETWORK_BODY_MAX * 4;
const TOTAL_BUFFER_BYTES = 50 * 1024 * 1024;

/**
 * 每个标签页上要用 Network 域的采集个数（含正在打开的）。调试连接按标签页共享（手机模拟
 * 也可能持有），最后一个采集释放时才关掉 Network 域，免得旧一轮录制把新一轮刚开的域关掉。
 */
const networkUsers = new Map<number, number>();

/**
 * 一次连接尝试持有的资源：租约与 Network 域计数，由同一个对象负责、只释放一次。
 * 连接被外部断开时计数随之撤销（连接已不在，不必也无法关域）。
 */
interface Holding {
  tabId: number;
  lease: DebuggerLease;
  /** 是否已计入 networkUsers。 */
  counted: boolean;
  released: boolean;
}

interface TabState {
  /** 当前的连接（含尚在初始化的）。 */
  holding?: Holding;
  /** 初始化完成、可以取请求体 / 响应体。 */
  ready?: boolean;
  attaching?: Promise<void>;
  /** 当前页面是否允许采集（普通网页）；跳到扩展页、about: 等之后不再接受新请求。 */
  eligible: boolean;
  /** 单调时钟（秒）→ 墙钟（毫秒）的偏移，由带 wallTime 的事件建立。 */
  clockOffset?: number;
  /** 顶层 frame 的 id，用来过滤 iframe 的文档请求。 */
  mainFrameId?: string;
}

function countNetworkUser(holding: Holding): void {
  if (holding.counted || holding.released) return;
  holding.counted = true;
  networkUsers.set(holding.tabId, (networkUsers.get(holding.tabId) ?? 0) + 1);
}

/** 撤销计数，返回是否已经没有别的采集在用这个标签页的 Network 域。 */
function uncountNetworkUser(holding: Holding): boolean {
  if (!holding.counted) return false;
  holding.counted = false;
  const remaining = (networkUsers.get(holding.tabId) ?? 1) - 1;
  if (remaining > 0) networkUsers.set(holding.tabId, remaining);
  else networkUsers.delete(holding.tabId);
  return remaining <= 0;
}

/** 释放一次连接：是最后一个用 Network 域的就先关域（租约此时仍有效），再释放租约。幂等。 */
async function releaseHolding(holding: Holding): Promise<void> {
  if (holding.released) return;
  holding.released = true;
  if (uncountNetworkUser(holding)) await holding.lease.send('Network.disable').catch(() => undefined);
  await holding.lease.release().catch(() => undefined);
}

/** 连接被外部断开：只撤销计数，不再发命令。 */
function dropHolding(holding: Holding): void {
  holding.released = true;
  uncountNetworkUser(holding);
}

interface PendingRequest {
  entry: NetworkEntry;
  /** 请求发出时的单调时间戳（秒）。 */
  startTimestamp?: number;
  mimeType?: string;
  /** 响应头里声明的正文字节数。 */
  declaredSize?: number;
  /** `Network.dataReceived` 累计的解压后字节数。 */
  decodedSize: number;
  /** 第几跳（重定向时加一）；异步取到的请求体只写回同一跳。 */
  hop: number;
}

// CDP 事件参数的结构因方法而异，这里按需读取字段
type CdpParams = Record<string, any>;

class CdpNetworkCapture {
  private readonly log: NetworkLogBuilder;
  private readonly onChange: () => void;
  private readonly tabs = new Map<number, TabState>();
  /** `${tabId}:${requestId}` → 进行中的请求。 */
  private readonly pending = new Map<string, PendingRequest>();
  /**
   * 正在取请求体 / 响应体的条目与对应字段，停止时等它们一会儿，超时且仍有效（请求体还是同一跳）
   * 的标为未取到。
   */
  private readonly inflight = new Map<
    Promise<void>,
    { entry: NetworkEntry; field: 'requestBody' | 'responseBody'; stillWanted: () => boolean }
  >();
  private observedTabId: number | null = null;
  private stopped = false;
  /** 已交出记录：之后到达的取体结果一律丢弃。 */
  private sealed = false;

  constructor(startedAt: number, onChange: () => void) {
    this.log = new NetworkLogBuilder(startedAt);
    this.onChange = onChange;
  }

  get count(): number {
    return this.log.count;
  }

  get state() {
    return this.log.liveState;
  }

  observe(tabId: number, url: string | undefined): void {
    this.observedTabId = tabId;
    this.pageChanged(tabId, url);
  }

  tabNavigated(tabId: number, url: string | undefined): void {
    this.pageChanged(tabId, url);
  }

  tabClosed(tabId: number): void {
    const tab = this.tabs.get(tabId);
    this.tabs.delete(tabId);
    if (this.observedTabId === tabId) this.observedTabId = null;
    // 标签页已经没了：撤销计数并释放租约（关域的命令会失败，无妨）
    if (tab?.holding) void releaseHolding(tab.holding);
  }

  async stop(): Promise<NetworkLog> {
    this.stopped = true;
    if (this.inflight.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.inflight.keys()]),
        new Promise((resolve) => setTimeout(resolve, STOP_DRAIN_MS)),
      ]);
    }
    // 还没取到的：标为未取到，之后晚到的结果不再写回
    for (const { entry, field, stillWanted } of this.inflight.values()) {
      if (!entry[field] && stillWanted()) entry[field] = { omitted: 'unavailable' };
    }
    this.sealed = true;
    // 含尚在初始化的连接：由这里释放，初始化流程随后发现不再需要时的释放是空操作
    const holdings = [...this.tabs.values()].map((tab) => tab.holding).filter((h): h is Holding => !!h);
    this.tabs.clear();
    await Promise.allSettled(holdings.map(releaseHolding));
    return this.log.toLog();
  }

  // ─── 连接 ───

  private pageChanged(tabId: number, url: string | undefined): void {
    if (this.stopped || this.log.aborted) return;
    const eligible = isInjectablePage(url);
    const tab = this.tabs.get(tabId);
    if (tab) tab.eligible = eligible;
    if (eligible && tabId === this.observedTabId) void this.ensureAttached(tabId);
  }

  /**
   * 幂等：每个标签页最多一份连接；连接被断开（标签页跳到无法调试的页面）后可重连。
   * 每次尝试的资源由一个 Holding 负责：登记到标签页后，停止、关闭标签页、被断开、初始化失败
   * 任一发生都只释放一次。
   */
  private ensureAttached(tabId: number): Promise<void> {
    let tab = this.tabs.get(tabId);
    if (!tab) {
      tab = { eligible: true };
      this.tabs.set(tabId, tab);
    }
    if (tab.holding) return Promise.resolve();
    if (tab.attaching) return tab.attaching;
    const state = tab;
    state.attaching = (async () => {
      let holding: Holding | undefined;
      /** 初始化途中被外部断开（如跳到无法调试的页面）。 */
      let detached = false;
      const current = () =>
        !!holding && !holding.released && !this.stopped && !this.log.aborted && this.tabs.get(tabId) === state;
      try {
        const lease = await acquireDebugger(tabId, {
          onEvent: (method, params) => this.handleEvent(tabId, method, params as CdpParams),
          onDetach: (reason) => {
            detached = true;
            if (holding) dropHolding(holding);
            if (state.holding === holding) {
              state.holding = undefined;
              state.ready = false;
            }
            this.handleDetach(reason);
          },
        });
        holding = { tabId, lease, counted: false, released: false };
        // 立即登记：之后的停止 / 关闭标签页由它们负责释放这份连接
        state.holding = holding;
        if (!current()) throw new Error('attach no longer needed');
        // 先记下顶层 frame 再开 Network 域：事件一到就能过滤 iframe 的文档请求
        const tree = await lease
          .send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree')
          .catch(() => undefined);
        if (!current()) throw new Error('attach no longer needed');
        state.mainFrameId = tree?.frameTree?.frame?.id;
        // 开域之前就计数：别的采集此时释放，不会把这里正在打开的域关掉
        countNetworkUser(holding);
        state.ready = true;
        await lease.send('Network.enable', {
          maxResourceBufferSize: RESOURCE_BUFFER_BYTES,
          maxTotalBufferSize: TOTAL_BUFFER_BYTES,
          // 超过单体上限的请求体不随事件带来，也不去读
          maxPostDataSize: NETWORK_BODY_MAX,
        });
        if (!current()) throw new Error('attach no longer needed');
        this.log.markAttached(tabId);
      } catch (err) {
        const stillNeeded = current();
        if (holding) {
          if (state.holding === holding) {
            state.holding = undefined;
            state.ready = false;
          }
          await releaseHolding(holding);
        }
        // 只有这次连接确实还需要、却失败了，才算这个标签页录不了
        if (stillNeeded || (!holding && !this.stopped && !this.log.aborted && this.tabs.get(tabId) === state)) {
          this.log.markTabUnavailable(tabId, err instanceof Error ? err.message : String(err));
        }
      } finally {
        state.attaching = undefined;
        this.onChange();
      }
      // 初始化途中被断开：这期间到来的「跳到普通网页，请连接」都被这次尝试吞掉了，按当前状态再连一次
      if (detached && !this.stopped && !this.log.aborted && this.tabs.get(tabId) === state
        && state.eligible && tabId === this.observedTabId) {
        void this.ensureAttached(tabId);
      }
    })();
    return state.attaching;
  }

  /** 可以用来取请求体 / 响应体的连接。 */
  private leaseOf(tabId: number): DebuggerLease | undefined {
    const tab = this.tabs.get(tabId);
    return tab?.ready && tab.holding && !tab.holding.released ? tab.holding.lease : undefined;
  }

  private handleDetach(reason: string): void {
    if (reason === 'canceled_by_user') {
      // 用户点了调试提示条上的「取消」：本扩展的所有调试连接都已断开，网络录制到此为止
      // 各标签页的连接通常都会各自收到断开通知；保险起见把仍登记着的也释放（已断开的命令会静默失败）
      this.log.abort(Date.now());
      for (const tab of this.tabs.values()) {
        if (tab.holding) void releaseHolding(tab.holding);
      }
      this.tabs.clear();
      this.onChange();
    }
    // target_closed：标签页关闭或跳到无法调试的页面，下一次可调试的导航再连
  }

  // ─── 事件 ───

  private wallTime(tabId: number, timestamp: number | undefined): number {
    const offset = this.tabs.get(tabId)?.clockOffset;
    return offset != null && timestamp != null ? timestamp * 1000 + offset : Date.now();
  }

  /** 这个标签页现在能不能登记新请求：是当前跟踪的标签页、当前是普通网页。 */
  private accepts(tabId: number): boolean {
    return tabId === this.observedTabId && this.tabs.get(tabId)?.eligible === true;
  }

  private handleEvent(tabId: number, method: string, params: CdpParams): void {
    if (this.stopped) return;
    const key = `${tabId}:${params.requestId}`;
    switch (method) {
      case 'Network.requestWillBeSent':
        this.onRequest(tabId, key, params);
        break;
      case 'Network.responseReceived': {
        const request = this.pending.get(key);
        if (!request) return;
        const response = params.response ?? {};
        request.entry.status = response.status;
        request.entry.statusText = response.statusText;
        const headers = headerList(response.headers);
        request.entry.responseHeaders = redactHeaders(headers);
        request.mimeType = response.mimeType;
        request.declaredSize = contentLength(headers);
        break;
      }
      case 'Network.dataReceived': {
        const request = this.pending.get(key);
        if (request && typeof params.dataLength === 'number') request.decodedSize += params.dataLength;
        break;
      }
      case 'Network.loadingFinished':
        this.onFinished(tabId, key, params);
        break;
      case 'Network.loadingFailed': {
        const request = this.pending.get(key);
        if (!request) return;
        this.pending.delete(key);
        request.entry.error = params.canceled ? 'canceled' : params.errorText;
        request.entry.durationMs = this.duration(request, params.timestamp);
        this.onChange();
        break;
      }
      case 'Network.eventSourceMessageReceived': {
        const request = this.pending.get(key);
        if (!request) return;
        this.log.addMessage(request.entry, 'received', this.wallTime(tabId, params.timestamp), String(params.data ?? ''));
        break;
      }
      case 'Network.webSocketCreated':
        this.onWebSocketCreated(tabId, key, params);
        break;
      case 'Network.webSocketWillSendHandshakeRequest': {
        const tab = this.tabs.get(tabId);
        if (tab && params.wallTime != null) tab.clockOffset = params.wallTime * 1000 - params.timestamp * 1000;
        const request = this.pending.get(key);
        if (request) {
          request.startTimestamp = params.timestamp;
          // 创建事件只有收到时刻；握手带着真实的发起时刻，以它为准
          if (params.wallTime != null) request.entry.t = this.log.offset(params.wallTime * 1000);
          request.entry.requestHeaders = redactHeaders(headerList(params.request?.headers));
        }
        break;
      }
      case 'Network.webSocketHandshakeResponseReceived': {
        const request = this.pending.get(key);
        if (!request) return;
        request.entry.status = params.response?.status;
        request.entry.statusText = params.response?.statusText;
        request.entry.responseHeaders = redactHeaders(headerList(params.response?.headers));
        break;
      }
      case 'Network.webSocketFrameSent':
      case 'Network.webSocketFrameReceived': {
        const request = this.pending.get(key);
        if (!request) return;
        const frame = params.response ?? {};
        // opcode 1 为文本帧；二进制帧（base64）对模型没有意义，只记占位
        const binary = frame.opcode !== 1;
        const data = binary ? '[binary frame]' : String(frame.payloadData ?? '');
        const direction = method === 'Network.webSocketFrameSent' ? 'sent' : 'received';
        this.log.addMessage(request.entry, direction, this.wallTime(tabId, params.timestamp), data, binary);
        break;
      }
      case 'Network.webSocketClosed': {
        const request = this.pending.get(key);
        if (!request) return;
        this.pending.delete(key);
        request.entry.durationMs = this.duration(request, params.timestamp);
        break;
      }
      case 'Network.webSocketFrameError': {
        const request = this.pending.get(key);
        if (request) request.entry.error = params.errorMessage;
        break;
      }
    }
  }

  private onRequest(tabId: number, key: string, params: CdpParams): void {
    const tab = this.tabs.get(tabId);
    if (tab && params.wallTime != null && params.timestamp != null) {
      tab.clockOffset = params.wallTime * 1000 - params.timestamp * 1000;
    }
    const request = params.request ?? {};
    const existing = this.pending.get(key);
    // 同一 requestId 再次出现并带 redirectResponse：上一跳被重定向了，条目换成新一跳的请求
    if (existing && params.redirectResponse) {
      const { entry } = existing;
      (entry.redirects ??= []).push({ url: entry.url, status: params.redirectResponse.status });
      existing.hop += 1;
      entry.url = redactUrl(request.url);
      entry.method = request.method;
      entry.requestHeaders = redactHeaders(headerList(request.headers));
      // 请求体跟着这一跳走（303 等改成 GET 后没有请求体）；旧一跳的退回额度
      this.log.discardBody(entry.requestBody);
      delete entry.requestBody;
      this.captureRequestBody(tabId, params, existing);
      return;
    }
    if (!this.accepts(tabId)) return;
    const type = fromCdpResourceType(params.type);
    if (!type) return;
    if (type === 'document' && tab?.mainFrameId && params.frameId !== tab.mainFrameId) return;
    const entry = this.log.addRequest({
      tabId,
      type,
      method: request.method,
      url: request.url,
      at: params.wallTime != null ? params.wallTime * 1000 : Date.now(),
      headers: headerList(request.headers),
    });
    if (!entry) {
      this.onChange();
      return;
    }
    const pending: PendingRequest = { entry, startTimestamp: params.timestamp, decodedSize: 0, hop: 0 };
    this.pending.set(key, pending);
    this.captureRequestBody(tabId, params, pending);
    this.onChange();
  }

  /** 请求体：随事件带来的直接记录；超过上限的不读；其余按需读取（只写回同一跳）。 */
  private captureRequestBody(tabId: number, params: CdpParams, pending: PendingRequest): void {
    const request = params.request ?? {};
    const headers = headerList(request.headers);
    const mimeType = contentType(headers);
    if (typeof request.postData === 'string') {
      pending.entry.requestBody = this.log.body(request.postData, mimeType);
      return;
    }
    if (!request.hasPostData) return;
    const declared = contentLength(headers);
    if (declared != null && declared > NETWORK_BODY_MAX) {
      pending.entry.requestBody = this.log.tooLarge(mimeType, declared);
      return;
    }
    const hop = pending.hop;
    const stillWanted = () => !this.sealed && pending.hop === hop;
    this.track(pending.entry, 'requestBody', stillWanted, (async () => {
      const lease = this.leaseOf(tabId);
      let postData: string | undefined;
      try {
        if (!lease) throw new Error('detached');
        ({ postData } = await lease.send<{ postData: string }>('Network.getRequestPostData', { requestId: params.requestId }));
      } catch {
        postData = undefined;
      }
      // 先确认结果仍有用再记录：记录会计入总量，过期的（已重定向、已交出）不能占额度
      if (stillWanted()) pending.entry.requestBody = this.log.body(postData, mimeType);
    })());
  }

  private onFinished(tabId: number, key: string, params: CdpParams): void {
    const request = this.pending.get(key);
    if (!request) return;
    this.pending.delete(key);
    const { entry } = request;
    entry.durationMs = this.duration(request, params.timestamp);
    // 推送流的内容已逐条记成消息
    if (entry.type === 'eventsource') return;
    const transferSize = typeof params.encodedDataLength === 'number' ? params.encodedDataLength : undefined;
    // 浏览器的缓冲按解压后的大小算：用解压后、头部声明、传输三者里最大的判断
    const knownSize = Math.max(request.decodedSize, request.declaredSize ?? 0, transferSize ?? 0) || undefined;
    const decision = this.log.shouldFetchBody(request.mimeType, knownSize, transferSize);
    if (decision !== true) {
      entry.responseBody = decision;
      return;
    }
    const { mimeType } = request;
    const stillWanted = () => !this.sealed;
    this.track(entry, 'responseBody', stillWanted, (async () => {
      const lease = this.leaseOf(tabId);
      let text: string | undefined;
      try {
        if (!lease) throw new Error('detached');
        const { body, base64Encoded } = await lease.send<{ body: string; base64Encoded: boolean }>(
          'Network.getResponseBody',
          { requestId: params.requestId },
        );
        text = base64Encoded ? new TextDecoder().decode(base64ToBytes(body)) : body;
      } catch {
        text = undefined;
      }
      // 先确认结果仍有用再记录：记录会计入总量
      if (!stillWanted()) return;
      entry.responseBody = text != null
        ? this.log.body(text, mimeType, transferSize)
        // 页面跳转等原因导致浏览器已丢掉了缓冲
        : { mimeType, omitted: 'evicted', ...(transferSize != null ? { transferSize } : {}) };
    })());
  }

  private onWebSocketCreated(tabId: number, key: string, params: CdpParams): void {
    if (!this.accepts(tabId)) return;
    const entry = this.log.addRequest({
      tabId,
      type: 'websocket',
      method: 'GET',
      url: params.url,
      at: Date.now(),
      headers: [],
    });
    if (entry) this.pending.set(key, { entry, decodedSize: 0, hop: 0 });
    this.onChange();
  }

  private duration(request: PendingRequest, timestamp: number | undefined): number | undefined {
    if (timestamp == null || request.startTimestamp == null) return undefined;
    return Math.max(0, Math.round((timestamp - request.startTimestamp) * 1000));
  }

  private track(
    entry: NetworkEntry,
    field: 'requestBody' | 'responseBody',
    stillWanted: () => boolean,
    task: Promise<void>,
  ): void {
    this.inflight.set(task, { entry, field, stillWanted });
    void task.finally(() => this.inflight.delete(task));
  }
}

// ─── 公开 API ───

export { CdpNetworkCapture };

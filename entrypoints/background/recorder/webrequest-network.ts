// Firefox：没有调试器 API，用 webRequest 在网络层旁观被跟踪标签页的请求（页面零改动）。
//
// 只能拿到请求与响应的元数据和请求体，拿不到响应体（Firefox 的 filterResponseData 需要截下
// 响应流再转发，出错会损坏页面收到的数据，不用）。需要可选权限 webRequest，由界面在用户
// 开启网络录制时申请；没有授权时整次录制标为 unavailable。只录普通网页上发起的请求。

import { browser, type Browser } from 'wxt/browser';
import { isInjectablePage } from '@/lib/browser/tab-actions';
import { NETWORK_BODY_MAX } from '@/lib/recorder/constants';
import { fromWebRequestType } from '@/lib/recorder/network-filter';
import { contentType } from '@/lib/recorder/network-headers';
import type { NetworkEntry, NetworkLog } from '@/lib/recorder/network-types';
import { redactHeaders } from '@/lib/recorder/redact';
import { redactUrl } from '@/lib/recorder/redact-values';
import { NetworkLogBuilder } from './network-log';

type WebRequest = typeof browser.webRequest;
type RequestBody = Browser.webRequest.OnBeforeRequestDetails['requestBody'];

/** 只关心这几类资源；其余在监听层面就不进来。 */
const REQUEST_FILTER = {
  urls: ['<all_urls>'],
  types: ['main_frame', 'xmlhttprequest', 'websocket'],
} as Browser.webRequest.RequestFilter;

function headerPairs(headers: Browser.webRequest.HttpHeader[] | undefined) {
  return (headers ?? []).map((h) => ({ name: h.name, value: h.value ?? '' }));
}

/** `HTTP/1.1 302 Found` → `Found`（与 Chrome 的 statusText 一致）。 */
function reasonPhrase(statusLine: string | undefined): string | undefined {
  return statusLine?.replace(/^\S+\s+\d+\s*/, '') || undefined;
}

type CapturedBody =
  | { kind: 'form'; text: string }
  | { kind: 'raw'; text: string }
  | { kind: 'too_large'; size: number };

/** 表单解析结果或原始字节 → 文本；超过单体上限的不合并、不解码。拿不到时返回 undefined。 */
function captureBody(body: RequestBody): CapturedBody | undefined {
  if (!body) return undefined;
  if (body.formData) {
    const params = new URLSearchParams();
    for (const [name, values] of Object.entries(body.formData)) {
      for (const value of values) params.append(name, String(value));
    }
    return { kind: 'form', text: params.toString() };
  }
  const parts = body.raw?.map((part) => part.bytes).filter((b): b is ArrayBuffer => !!b);
  if (!parts?.length) return undefined;
  const size = parts.reduce((n, b) => n + b.byteLength, 0);
  if (size > NETWORK_BODY_MAX) return { kind: 'too_large', size };
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    merged.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }
  return { kind: 'raw', text: new TextDecoder().decode(merged) };
}

class WebRequestNetworkCapture {
  private readonly log: NetworkLogBuilder;
  private readonly onChange: () => void;
  /** requestId → 条目（Firefox 的 requestId 在重定向前后保持不变）。 */
  private readonly pending = new Map<string, NetworkEntry>();
  private readonly startTimes = new Map<string, number>();
  /** 原始字节的请求体要等拿到真实的 Content-Type（onSendHeaders）才能决定怎么打码，先暂存。 */
  private readonly rawBodies = new Map<string, string>();
  /**
   * 收到重定向通知、还没等到下一跳请求的：requestId → 重定向的状态码。下一跳的 onBeforeRequest
   * 到了才把条目整体换成新一跳；没等到（如跳到 data: 等不经网络的地址）就保留最后实际发出的那一跳。
   */
  private readonly redirecting = new Map<string, number>();
  private observedTabId: number | null = null;
  /** 当前跟踪的标签页是不是普通网页（扩展页、about: 等不录）。 */
  private observedEligible = false;
  private stopped = false;
  /** 录制中权限被撤销：不再处理任何事件。 */
  private revoked = false;
  private removeListeners?: () => void;

  constructor(startedAt: number, onChange: () => void) {
    this.log = new NetworkLogBuilder(startedAt);
    this.onChange = onChange;
    void this.install().catch((err: unknown) => {
      this.log.markUnavailable(err instanceof Error ? err.message : String(err));
      this.onChange();
    });
  }

  get count(): number {
    return this.log.count;
  }

  get state() {
    return this.log.liveState;
  }

  observe(tabId: number, url: string | undefined): void {
    this.observedTabId = tabId;
    this.observedEligible = isInjectablePage(url);
  }

  tabNavigated(tabId: number, url: string | undefined): void {
    // 监听是全局的，不需要逐个标签页连接；只更新这个标签页能不能录
    if (tabId === this.observedTabId) this.observedEligible = isInjectablePage(url);
  }

  tabClosed(tabId: number): void {
    if (this.observedTabId === tabId) this.observedTabId = null;
  }

  async stop(): Promise<NetworkLog> {
    this.stopped = true;
    this.removeListeners?.();
    this.removeListeners = undefined;
    // 一直没等到请求头的请求体：按未知类型处理
    for (const [requestId, text] of this.rawBodies) {
      const entry = this.pending.get(requestId);
      if (entry) entry.requestBody = this.log.body(text, undefined);
    }
    this.rawBodies.clear();
    return this.log.toLog();
  }

  private async install(): Promise<void> {
    const webRequest: WebRequest | undefined = browser.webRequest;
    const granted = await browser.permissions.contains({ permissions: ['webRequest'] });
    // 等权限查询期间录制可能已经停了：不再装监听
    if (this.stopped) return;
    if (!webRequest || !granted) {
      this.log.markUnavailable('the webRequest permission has not been granted');
      this.onChange();
      return;
    }

    // 只旁观不拦截：监听返回 undefined（类型上与阻塞式监听共用一个签名）
    const onBeforeRequest = (details: Browser.webRequest.OnBeforeRequestDetails): undefined => {
      if (this.stopped || this.revoked) return;
      // 重定向后同一个 requestId 会再来一次：沿用原条目（地址已在 onBeforeRedirect 里更新）
      const existing = this.pending.get(details.requestId);
      if (existing) {
        const status = this.redirecting.get(details.requestId);
        this.redirecting.delete(details.requestId);
        // 上一跳的信息归入重定向链，条目整体换成新一跳；新一跳若在收到响应前失败，不会留着旧的冒充
        (existing.redirects ??= []).push({ url: existing.url, status: status ?? existing.status ?? 0 });
        existing.url = redactUrl(details.url);
        existing.method = details.method;
        existing.requestHeaders = [];
        delete existing.status;
        delete existing.statusText;
        delete existing.responseHeaders;
        this.log.discardBody(existing.requestBody);
        delete existing.requestBody;
        this.rawBodies.delete(details.requestId);
        this.captureRequestBody(details.requestId, existing, details.requestBody);
        return;
      }
      if (details.tabId !== this.observedTabId) return;
      const type = fromWebRequestType(details.type);
      if (!type) return;
      // 顶层文档按它自己的地址判断（跳转时标签页的地址还没更新）；其余按当前页面判断
      const eligible = type === 'document' ? isInjectablePage(details.url) : this.observedEligible;
      if (!eligible) return;
      const entry = this.log.addRequest({
        tabId: details.tabId,
        type,
        method: details.method,
        url: details.url,
        at: details.timeStamp,
        headers: [],
      });
      this.onChange();
      if (!entry) return;
      this.pending.set(details.requestId, entry);
      this.startTimes.set(details.requestId, details.timeStamp);
      this.captureRequestBody(details.requestId, entry, details.requestBody);
    };
    const onSendHeaders = (details: Browser.webRequest.OnSendHeadersDetails) => {
      if (this.stopped || this.revoked) return;
      const entry = this.pending.get(details.requestId);
      if (!entry) return;
      entry.requestHeaders = redactHeaders(headerPairs(details.requestHeaders));
      const raw = this.rawBodies.get(details.requestId);
      if (raw != null) {
        this.rawBodies.delete(details.requestId);
        entry.requestBody = this.log.body(raw, contentType(entry.requestHeaders));
      }
    };
    const onHeadersReceived = (details: Browser.webRequest.OnHeadersReceivedDetails): undefined => {
      if (this.stopped || this.revoked) return;
      const entry = this.pending.get(details.requestId);
      if (!entry) return;
      entry.status = details.statusCode;
      entry.statusText = reasonPhrase(details.statusLine);
      entry.responseHeaders = redactHeaders(headerPairs(details.responseHeaders));
    };
    const onBeforeRedirect = (details: Browser.webRequest.OnBeforeRedirectDetails) => {
      if (this.stopped || this.revoked) return;
      if (!this.pending.has(details.requestId)) return;
      this.redirecting.set(details.requestId, details.statusCode);
    };
    const finish = (details: { requestId: string; timeStamp: number }, error?: string) => {
      if (this.stopped || this.revoked) return;
      const entry = this.pending.get(details.requestId);
      if (!entry) return;
      this.pending.delete(details.requestId);
      this.redirecting.delete(details.requestId);
      const raw = this.rawBodies.get(details.requestId);
      if (raw != null) {
        this.rawBodies.delete(details.requestId);
        entry.requestBody = this.log.body(raw, contentType(entry.requestHeaders));
      }
      const startedAt = this.startTimes.get(details.requestId);
      this.startTimes.delete(details.requestId);
      if (startedAt != null) entry.durationMs = Math.max(0, Math.round(details.timeStamp - startedAt));
      if (error) entry.error = error;
      else if (entry.type !== 'websocket') entry.responseBody = { mimeType: contentType(entry.responseHeaders), omitted: 'unavailable' };
      this.onChange();
    };
    const onCompleted = (details: Browser.webRequest.OnCompletedDetails) => finish(details);
    const onErrorOccurred = (details: Browser.webRequest.OnErrorOccurredDetails) => finish(details, details.error);

    // 逐个登记撤销操作：中途注册失败时回滚已装上的，整次标为不可用
    const undo: Array<() => void> = [];
    // 录制中用户撤销了权限：浏览器会注销这些监听，按「中途中止」记下，并清理自己的登记
    const onPermissionRemoved = (removed: Browser.permissions.Permissions) => {
      if (this.stopped || !removed.permissions?.includes('webRequest')) return;
      this.log.abort(Date.now());
      // 之后到达的事件一律不记（即便有监听没能移除）
      this.revoked = true;
      // 先广播状态：撤权后旧监听的移除即便报错，也不影响提示用户
      this.onChange();
      this.removeListeners?.();
      this.removeListeners = undefined;
    };
    this.removeListeners = () => {
      for (const remove of undo.splice(0)) {
        try {
          remove();
        } catch (err) {
          console.warn('[recorder] failed to remove a webRequest listener:', err);
        }
      }
    };
    try {
      browser.permissions.onRemoved.addListener(onPermissionRemoved);
      undo.push(() => browser.permissions.onRemoved.removeListener(onPermissionRemoved));
      webRequest.onBeforeRequest.addListener(onBeforeRequest, REQUEST_FILTER, ['requestBody']);
      undo.push(() => webRequest.onBeforeRequest.removeListener(onBeforeRequest));
      webRequest.onSendHeaders.addListener(onSendHeaders, REQUEST_FILTER, ['requestHeaders']);
      undo.push(() => webRequest.onSendHeaders.removeListener(onSendHeaders));
      webRequest.onHeadersReceived.addListener(onHeadersReceived, REQUEST_FILTER, ['responseHeaders']);
      undo.push(() => webRequest.onHeadersReceived.removeListener(onHeadersReceived));
      webRequest.onBeforeRedirect.addListener(onBeforeRedirect, REQUEST_FILTER);
      undo.push(() => webRequest.onBeforeRedirect.removeListener(onBeforeRedirect));
      webRequest.onCompleted.addListener(onCompleted, REQUEST_FILTER);
      undo.push(() => webRequest.onCompleted.removeListener(onCompleted));
      webRequest.onErrorOccurred.addListener(onErrorOccurred, REQUEST_FILTER);
      undo.push(() => webRequest.onErrorOccurred.removeListener(onErrorOccurred));
    } catch (err) {
      this.stopped = true;
      this.removeListeners();
      throw err;
    }
    this.log.markAttached();
    this.onChange();
  }

  /**
   * 请求体：Firefox 给出的是已解析的表单字段（urlencoded 与 multipart 都如此），统一按 urlencoded
   * 记录；原始字节先暂存，等请求头到了再按真实类型打码。
   */
  private captureRequestBody(requestId: string, entry: NetworkEntry, body: RequestBody): void {
    const captured = captureBody(body);
    if (!captured) return;
    if (captured.kind === 'form') entry.requestBody = this.log.body(captured.text, 'application/x-www-form-urlencoded');
    else if (captured.kind === 'too_large') entry.requestBody = this.log.tooLarge(undefined, captured.size);
    else this.rawBodies.set(requestId, captured.text);
  }
}

// ─── 公开 API ───

export { WebRequestNetworkCapture };

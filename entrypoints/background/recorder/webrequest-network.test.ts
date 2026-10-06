import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 假的 webRequest：记下各事件的监听，测试里按顺序派发。 */
type Listener = (details: Record<string, unknown>) => void;
const listeners = new Map<string, Set<Listener>>();
let granted: Promise<boolean>;
/** 第几次 addListener 抛错（故障注入）；0 表示不抛。 */
let failOnAdd = 0;
let addCount = 0;

function event(name: string) {
  return {
    addListener: (fn: Listener) => {
      if (++addCount === failOnAdd) throw new Error('addListener failed');
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(fn);
    },
    removeListener: (fn: Listener) => listeners.get(name)?.delete(fn),
  };
}

vi.mock('wxt/browser', () => ({
  browser: {
    permissions: { contains: () => granted, onRemoved: event('permissions.onRemoved') },
    webRequest: Object.fromEntries(
      ['onBeforeRequest', 'onSendHeaders', 'onHeadersReceived', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred']
        .map((name) => [name, event(name)]),
    ),
  },
}));

const { WebRequestNetworkCapture } = await import('./webrequest-network');

const START = 1_700_000_000_000;

function fire(name: string, details: Record<string, unknown>) {
  for (const fn of listeners.get(name) ?? []) fn({ requestId: 'r1', tabId: 1, timeStamp: START + 100, ...details });
}

function listenerCount(): number {
  return [...listeners.values()].reduce((n, set) => n + set.size, 0);
}

beforeEach(() => {
  listeners.clear();
  granted = Promise.resolve(true);
  failOnAdd = 0;
  addCount = 0;
});

async function started() {
  const capture = new WebRequestNetworkCapture(START, () => {});
  capture.observe(1, 'https://app.test/');
  // 6 个 webRequest 监听 + 权限撤销监听
  await vi.waitFor(() => expect(listenerCount()).toBe(7));
  return capture;
}

describe('WebRequestNetworkCapture', () => {
  it('未授予 webRequest 权限时整次标为不可用，不装监听', async () => {
    granted = Promise.resolve(false);
    const capture = new WebRequestNetworkCapture(START, () => {});
    await vi.waitFor(() => expect(capture.state).toBe('unavailable'));
    expect(listenerCount()).toBe(0);
  });

  it('权限查询还没返回就停止：之后不再装监听', async () => {
    let resolve!: (value: boolean) => void;
    granted = new Promise((r) => { resolve = r; });
    const capture = new WebRequestNetworkCapture(START, () => {});
    await capture.stop();
    resolve(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(listenerCount()).toBe(0);
  });

  it('重定向沿用同一条目：保留重定向链、首跳开始时间，状态取最后一跳', async () => {
    const capture = await started();
    fire('onBeforeRequest', { type: 'main_frame', method: 'GET', url: 'https://app.test/start?code=LEAK6rQ8' });
    fire('onHeadersReceived', { statusCode: 302, statusLine: 'HTTP/1.1 302 Found', responseHeaders: [] });
    fire('onBeforeRedirect', { statusCode: 302, redirectUrl: 'https://app.test/home' });
    fire('onBeforeRequest', { type: 'main_frame', method: 'GET', url: 'https://app.test/home', timeStamp: START + 150 });
    fire('onHeadersReceived', { statusCode: 200, statusLine: 'HTTP/1.1 200 OK', responseHeaders: [] });
    fire('onCompleted', { timeStamp: START + 300 });
    const log = await capture.stop();
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ url: 'https://app.test/home', status: 200, statusText: 'OK', durationMs: 200 });
    expect(log.entries[0].redirects).toHaveLength(1);
    expect(JSON.stringify(log)).not.toContain('LEAK6rQ8');
  });

  it('原始字节的请求体等拿到真实 Content-Type 再打码', async () => {
    const capture = await started();
    const bytes = new TextEncoder().encode('user=alice&password=LEAK6rQ8').buffer;
    fire('onBeforeRequest', { type: 'xmlhttprequest', method: 'PUT', url: 'https://api.test/form', requestBody: { raw: [{ bytes }] } });
    fire('onSendHeaders', { requestHeaders: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }] });
    fire('onCompleted', { timeStamp: START + 200 });
    const log = await capture.stop();
    expect(log.entries[0].requestBody?.text).toContain('user=alice');
    expect(log.entries[0].requestBody?.text).not.toContain('LEAK6rQ8');
    expect(log.entries[0].responseBody).toMatchObject({ omitted: 'unavailable' });
  });

  it('只录当前跟踪的标签页、且是普通网页上的请求', async () => {
    const capture = await started();
    fire('onBeforeRequest', { requestId: 'other', tabId: 2, type: 'xmlhttprequest', method: 'GET', url: 'https://x.test/' });
    capture.tabNavigated(1, 'moz-extension://abc/sidepanel.html');
    fire('onBeforeRequest', { requestId: 'ext', type: 'xmlhttprequest', method: 'GET', url: 'https://api.test/' });
    capture.tabNavigated(1, 'https://app.test/');
    fire('onBeforeRequest', { requestId: 'ok', type: 'xmlhttprequest', method: 'GET', url: 'https://api.test/ok' });
    const log = await capture.stop();
    expect(log.entries.map((e) => e.url)).toEqual(['https://api.test/ok']);
    expect(listenerCount()).toBe(0);
  });

  it('监听中途注册失败：回滚已装上的，整次标为不可用', async () => {
    failOnAdd = 4;
    const capture = new WebRequestNetworkCapture(START, () => {});
    await vi.waitFor(() => expect(capture.state).toBe('unavailable'));
    expect(listenerCount()).toBe(0);
    await capture.stop();
  });

  it('重定向后新一跳在收到响应前失败：不保留上一跳的状态与头部', async () => {
    const capture = await started();
    fire('onBeforeRequest', { type: 'main_frame', method: 'GET', url: 'https://app.test/a' });
    fire('onHeadersReceived', { statusCode: 302, statusLine: 'HTTP/1.1 302 Found', responseHeaders: [{ name: 'X-A', value: '1' }] });
    fire('onBeforeRedirect', { statusCode: 302, redirectUrl: 'https://unknown.test/b' });
    fire('onBeforeRequest', { type: 'main_frame', method: 'GET', url: 'https://unknown.test/b' });
    fire('onErrorOccurred', { error: 'NS_ERROR_UNKNOWN_HOST', timeStamp: START + 200 });
    const [entry] = (await capture.stop()).entries;
    expect(entry).toMatchObject({ url: 'https://unknown.test/b', error: 'NS_ERROR_UNKNOWN_HOST' });
    expect(entry.status).toBeUndefined();
    expect(entry.responseHeaders).toBeUndefined();
    expect(entry.redirects).toEqual([{ url: 'https://app.test/a', status: 302 }]);
  });

  it('重定向后没等到下一跳请求（如跳到 data: 地址）：保留最后实际发出的那一跳', async () => {
    const capture = await started();
    fire('onBeforeRequest', {
      type: 'main_frame', method: 'POST', url: 'https://app.test/submit',
      requestBody: { formData: { title: ['hello'] } },
    });
    fire('onHeadersReceived', { statusCode: 303, statusLine: 'HTTP/1.1 303 See Other', responseHeaders: [] });
    fire('onBeforeRedirect', { statusCode: 303, redirectUrl: 'data:text/plain,ok' });
    const [entry] = (await capture.stop()).entries;
    expect(entry).toMatchObject({ url: 'https://app.test/submit', method: 'POST', status: 303 });
    expect(entry.requestBody?.text).toBe('title=hello');
    expect(entry.redirects).toBeUndefined();
  });

  it('录制中撤销 webRequest 权限：按中途中止记录，清理监听', async () => {
    const capture = await started();
    fire('onBeforeRequest', { type: 'xmlhttprequest', method: 'GET', url: 'https://api.test/a' });
    for (const fn of listeners.get('permissions.onRemoved') ?? []) fn({ permissions: ['webRequest'] });
    expect(capture.state).toBe('aborted');
    expect(listenerCount()).toBe(0);
    const log = await capture.stop();
    expect(log.state).toBe('aborted');
    expect(log.entries).toHaveLength(1);
  });
});

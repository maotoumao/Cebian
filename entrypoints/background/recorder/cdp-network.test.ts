import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DebuggerLeaseHandlers } from '@/lib/browser/debugger-session';

/** 假的调试连接：记下每个标签页的事件回调，命令按 `responses` 应答。 */
const leases = new Map<number, { handlers: DebuggerLeaseHandlers; release: ReturnType<typeof vi.fn> }>();
/** 发出过的命令（按顺序）。 */
const sent: string[] = [];
const acquireDebugger = vi.fn();
let responses: Record<string, (params: Record<string, unknown>) => unknown>;

vi.mock('@/lib/browser/debugger-session', () => ({
  acquireDebugger: (...args: unknown[]) => acquireDebugger(...args),
  isDebuggerAvailable: () => true,
}));

const { CdpNetworkCapture } = await import('./cdp-network');

const START = 1_700_000_000_000;
/** CDP 单调时钟（秒）与墙钟的对应：timestamp 100 ↔ START + 1000ms。 */
const wallTime = (timestamp: number) => (START + 1000) / 1000 + (timestamp - 100);

function emit(tabId: number, method: string, params: Record<string, unknown>) {
  leases.get(tabId)!.handlers.onEvent!(method, params);
}

beforeEach(() => {
  leases.clear();
  sent.length = 0;
  responses = {
    'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'main' } } }),
  };
  acquireDebugger.mockReset();
  acquireDebugger.mockImplementation(async (tabId: number, handlers: DebuggerLeaseHandlers) => {
    const release = vi.fn(async () => {});
    leases.set(tabId, { handlers, release });
    return {
      tabId,
      adopted: false,
      release,
      send: async (method: string, params: Record<string, unknown> = {}) => {
        sent.push(method);
        const respond = responses[method];
        if (!respond) return {};
        return respond(params);
      },
    };
  });
});

async function attached(tabId = 1, url = 'https://app.test/') {
  const onChange = vi.fn();
  const capture = new CdpNetworkCapture(START, onChange);
  capture.observe(tabId, url);
  await vi.waitFor(() => expect(capture.state).toBe('active'));
  await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
  return { capture, onChange };
}

function sendRequest(tabId: number, requestId: string, timestamp: number, overrides: Record<string, unknown> = {}) {
  emit(tabId, 'Network.requestWillBeSent', {
    requestId,
    type: 'Fetch',
    frameId: 'main',
    timestamp,
    wallTime: wallTime(timestamp),
    request: { method: 'POST', url: 'https://api.test/login', headers: { 'Content-Type': 'application/json' }, postData: '{"password":"LEAK6rQ8","user":"a"}' },
    ...overrides,
  });
}

describe('CdpNetworkCapture', () => {
  it('同一标签页只租一份连接；非普通网页不连；停止时释放', async () => {
    const { capture } = await attached();
    capture.observe(1, 'https://app.test/other');
    capture.tabNavigated(1, 'https://app.test/next');
    capture.observe(2, 'chrome://settings');
    expect(acquireDebugger).toHaveBeenCalledTimes(1);
    await capture.stop();
    expect(leases.get(1)!.release).toHaveBeenCalled();
  });

  it('请求→响应→结束：时间按墙钟换算，请求体与响应体打码，响应体按需读取', async () => {
    responses['Network.getResponseBody'] = () => ({ body: '{"access_token":"LEAK6rQ8","ok":true}', base64Encoded: false });
    const { capture } = await attached();
    sendRequest(1, 'r1', 100.5);
    emit(1, 'Network.responseReceived', {
      requestId: 'r1',
      response: { status: 200, statusText: 'OK', mimeType: 'application/json', headers: { 'Set-Cookie': 'sid=LEAK6rQ8' } },
    });
    emit(1, 'Network.loadingFinished', { requestId: 'r1', timestamp: 100.75, encodedDataLength: 40 });
    const log = await capture.stop();
    expect(log.entries).toHaveLength(1);
    const [entry] = log.entries;
    expect(entry).toMatchObject({ t: 1500, method: 'POST', status: 200, durationMs: 250, type: 'fetch' });
    expect(JSON.stringify(entry)).not.toContain('LEAK6rQ8');
    expect(entry.requestBody?.text).toContain('"user":"a"');
    expect(entry.responseBody?.text).toContain('"ok":true');
  });

  it('只录当前跟踪的标签页与顶层文档；重定向链合并到同一条', async () => {
    const { capture } = await attached();
    sendRequest(1, 'iframe', 101, { type: 'Document', frameId: 'child' });
    sendRequest(1, 'doc', 102, {
      type: 'Document',
      request: { method: 'GET', url: 'https://app.test/start?code=LEAK6rQ8', headers: {} },
    });
    sendRequest(1, 'doc', 102.1, {
      type: 'Document',
      request: { method: 'GET', url: 'https://app.test/home', headers: {} },
      redirectResponse: { status: 302 },
    });
    sendRequest(1, 'img', 103, { type: 'Image' });
    const log = await capture.stop();
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ type: 'document', url: 'https://app.test/home' });
    expect(log.entries[0].redirects).toHaveLength(1);
    expect(log.entries[0].redirects![0]).toMatchObject({ status: 302 });
    expect(log.entries[0].redirects![0].url).not.toContain('LEAK6rQ8');
  });

  it('切到别的标签页后，旧标签页的新请求不再记录，但已开始的请求照常收尾', async () => {
    responses['Network.getResponseBody'] = () => ({ body: '{"n":1}', base64Encoded: false });
    const { capture } = await attached();
    sendRequest(1, 'before', 101);
    capture.observe(2, 'https://other.test/');
    await vi.waitFor(() => expect(leases.has(2)).toBe(true));
    sendRequest(1, 'after', 102);
    emit(1, 'Network.responseReceived', { requestId: 'before', response: { status: 201, mimeType: 'application/json', headers: {} } });
    emit(1, 'Network.loadingFinished', { requestId: 'before', timestamp: 101.1, encodedDataLength: 7 });
    const log = await capture.stop();
    expect(log.entries.map((e) => e.status)).toEqual([201]);
  });

  it('响应体：二进制与超大的不读取，读取失败记为已被浏览器丢弃', async () => {
    responses['Network.getResponseBody'] = () => { throw new Error('No resource with given identifier found'); };
    const { capture } = await attached();
    for (const [id, mimeType, size] of [['bin', 'image/png', 10], ['big', 'application/json', 10_000_000], ['gone', 'application/json', 10]] as const) {
      sendRequest(1, id, 101);
      emit(1, 'Network.responseReceived', { requestId: id, response: { status: 200, mimeType, headers: {} } });
      emit(1, 'Network.loadingFinished', { requestId: id, timestamp: 101.2, encodedDataLength: size });
    }
    const log = await capture.stop();
    expect(log.entries.map((e) => e.responseBody?.omitted).sort()).toEqual(['binary', 'evicted', 'too_large']);
  });

  it('推送流：EventSource 消息与 WebSocket 帧作为预览记录，并打码', async () => {
    const { capture } = await attached();
    sendRequest(1, 'sse', 101, { type: 'EventSource', request: { method: 'GET', url: 'https://api.test/stream', headers: {} } });
    emit(1, 'Network.eventSourceMessageReceived', { requestId: 'sse', timestamp: 101.5, data: '{"token":"LEAK6rQ8"}' });
    emit(1, 'Network.webSocketCreated', { requestId: 'ws', url: 'wss://api.test/socket?token=LEAK6rQ8' });
    emit(1, 'Network.webSocketFrameReceived', { requestId: 'ws', timestamp: 102, response: { opcode: 1, payloadData: '42["msg",{"password":"LEAK6rQ8"}]' } });
    emit(1, 'Network.webSocketFrameSent', { requestId: 'ws', timestamp: 102.1, response: { opcode: 2, payloadData: 'AAEC' } });
    const log = await capture.stop();
    expect(JSON.stringify(log)).not.toContain('LEAK6rQ8');
    const ws = log.entries.find((e) => e.type === 'websocket')!;
    expect(ws.messages!.map((m) => m.direction)).toEqual(['received', 'sent']);
    expect(ws.messages![1]).toMatchObject({ binary: true });
    expect(log.entries.find((e) => e.type === 'eventsource')!.messages).toHaveLength(1);
  });

  it('用户取消调试提示条：网络录制中止，之后不再连接', async () => {
    const { capture } = await attached();
    leases.get(1)!.handlers.onDetach!('canceled_by_user');
    expect(capture.state).toBe('aborted');
    capture.observe(2, 'https://other.test/');
    const log = await capture.stop();
    expect(log.state).toBe('aborted');
    expect(acquireDebugger).toHaveBeenCalledTimes(1);
  });

  it('连接因跳到无法调试的页面被断开：下一次普通网页的跳转重新连接', async () => {
    const { capture } = await attached();
    leases.get(1)!.handlers.onDetach!('target_closed');
    capture.tabNavigated(1, 'https://app.test/again');
    await vi.waitFor(() => expect(acquireDebugger).toHaveBeenCalledTimes(2));
    expect(capture.state).toBe('active');
    await capture.stop();
  });

  it('连接失败（如被其它调试器占用）时标为不可用', async () => {
    acquireDebugger.mockRejectedValueOnce(new Error('Another debugger is already attached'));
    const capture = new CdpNetworkCapture(START, () => {});
    capture.observe(1, 'https://app.test/');
    await vi.waitFor(() => expect(capture.state).toBe('unavailable'));
    expect((await capture.stop()).unavailableReason).toMatch(/Another debugger/);
  });

  it('停止时等待正在读取的响应体（有上限），读到的内容仍然记录', async () => {
    let finish!: (value: unknown) => void;
    responses['Network.getResponseBody'] = () => new Promise((resolve) => { finish = resolve; });
    const { capture } = await attached();
    sendRequest(1, 'slow', 101);
    emit(1, 'Network.responseReceived', { requestId: 'slow', response: { status: 200, mimeType: 'application/json', headers: {} } });
    emit(1, 'Network.loadingFinished', { requestId: 'slow', timestamp: 101.2, encodedDataLength: 10 });
    const stopping = capture.stop();
    finish({ body: '{"n":2}', base64Encoded: false });
    const log = await stopping;
    expect(log.entries[0].responseBody?.text).toBe('{"n":2}');
  });

  it('连接过程中录制停止：连上之后立即释放，不留下无人持有的连接', async () => {
    let finishEnable!: () => void;
    responses['Network.enable'] = () => new Promise<void>((resolve) => { finishEnable = resolve; });
    const capture = new CdpNetworkCapture(START, () => {});
    capture.observe(1, 'https://app.test/');
    await vi.waitFor(() => expect(finishEnable).toBeTypeOf('function'));
    await capture.stop();
    finishEnable();
    await vi.waitFor(() => expect(leases.get(1)!.release).toHaveBeenCalled());
  });

  it('开 Network 域失败：释放已租到的连接，标为不可用', async () => {
    responses['Network.enable'] = () => { throw new Error('enable failed'); };
    const capture = new CdpNetworkCapture(START, () => {});
    capture.observe(1, 'https://app.test/');
    await vi.waitFor(() => expect(capture.state).toBe('unavailable'));
    expect(leases.get(1)!.release).toHaveBeenCalled();
    await capture.stop();
  });

  it('连接过程中被断开：不留下失效的租约，下一次跳转重新连接', async () => {
    let finishTree!: () => void;
    responses['Page.getFrameTree'] = () => new Promise((resolve) => { finishTree = () => resolve({}); });
    const capture = new CdpNetworkCapture(START, () => {});
    capture.observe(1, 'https://app.test/');
    await vi.waitFor(() => expect(finishTree).toBeTypeOf('function'));
    leases.get(1)!.handlers.onDetach!('target_closed');
    // 断开后、这次尝试收尾之前只来一次跳转通知
    capture.tabNavigated(1, 'https://app.test/again');
    responses['Page.getFrameTree'] = () => ({ frameTree: { frame: { id: 'main' } } });
    finishTree();
    await vi.waitFor(() => expect(acquireDebugger).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(sent).toContain('Network.enable'));
    await capture.stop();
  });

  it('连接过程中标签页被关闭：释放连接，不把它算作录不了', async () => {
    let finishEnable!: () => void;
    responses['Network.enable'] = () => new Promise<void>((resolve) => { finishEnable = resolve; });
    const capture = new CdpNetworkCapture(START, () => {});
    capture.observe(1, 'https://app.test/');
    await vi.waitFor(() => expect(finishEnable).toBeTypeOf('function'));
    capture.tabClosed(1);
    finishEnable();
    await vi.waitFor(() => expect(leases.get(1)!.release).toHaveBeenCalled());
    const log = await capture.stop();
    expect(log.state).toBe('active');
    expect(log.unavailableTabs).toBeUndefined();
  });

  it('请求体不在事件里时按需读取；声明超过上限的不读；重定向后旧一跳的请求体不写回', async () => {
    let finishPost!: (value: unknown) => void;
    responses['Network.getRequestPostData'] = () => new Promise((resolve) => { finishPost = resolve; });
    const { capture } = await attached();
    sendRequest(1, 'big', 101, {
      request: { method: 'POST', url: 'https://api.test/upload', headers: { 'Content-Length': '999999' }, hasPostData: true },
    });
    sendRequest(1, 'redir', 102, {
      request: { method: 'POST', url: 'https://api.test/login', headers: { 'Content-Type': 'application/json' }, hasPostData: true },
    });
    await vi.waitFor(() => expect(finishPost).toBeTypeOf('function'));
    sendRequest(1, 'redir', 102.1, {
      request: { method: 'GET', url: 'https://api.test/home', headers: {} },
      redirectResponse: { status: 303 },
    });
    finishPost({ postData: '{"user":"a"}' });
    const log = await capture.stop();
    const big = log.entries.find((e) => e.url.endsWith('/upload'))!;
    const redirected = log.entries.find((e) => e.url.endsWith('/home'))!;
    expect(big.requestBody).toMatchObject({ omitted: 'too_large', size: 999999 });
    expect(redirected.method).toBe('GET');
    expect(redirected.requestBody).toBeUndefined();
    expect(sent.filter((m) => m === 'Network.getRequestPostData')).toHaveLength(1);
  });

  it('跳到扩展页 / about: 等之后，同一连接上的新请求不再记录', async () => {
    const { capture } = await attached();
    capture.tabNavigated(1, 'about:blank');
    sendRequest(1, 'after', 101);
    capture.tabNavigated(1, 'https://app.test/back');
    sendRequest(1, 'back', 102);
    const log = await capture.stop();
    expect(log.entries).toHaveLength(1);
  });

  it('解压后的大小超过上限时不读响应体（浏览器也不会缓冲它）', async () => {
    const { capture } = await attached();
    sendRequest(1, 'gz', 101);
    emit(1, 'Network.responseReceived', { requestId: 'gz', response: { status: 200, mimeType: 'application/json', headers: {} } });
    emit(1, 'Network.dataReceived', { requestId: 'gz', dataLength: 300_000, encodedDataLength: 20_000 });
    emit(1, 'Network.loadingFinished', { requestId: 'gz', timestamp: 101.2, encodedDataLength: 20_000 });
    const log = await capture.stop();
    expect(log.entries[0].responseBody).toMatchObject({ omitted: 'too_large', size: 300_000, transferSize: 20_000 });
    expect(sent).not.toContain('Network.getResponseBody');
  });

  it('WebSocket 的开始时刻以握手的真实时刻为准', async () => {
    const { capture } = await attached();
    emit(1, 'Network.webSocketCreated', { requestId: 'ws', url: 'wss://api.test/socket' });
    emit(1, 'Network.webSocketWillSendHandshakeRequest', { requestId: 'ws', timestamp: 100.2, wallTime: wallTime(100.2), request: { headers: {} } });
    const log = await capture.stop();
    expect(log.entries[0].t).toBe(1200);
  });

  it('停止时：最后一个用 Network 域的采集关掉它；还有别的采集在用时不关', async () => {
    const first = await attached();
    const second = await attached();
    await first.capture.stop();
    expect(sent.filter((m) => m === 'Network.disable')).toHaveLength(0);
    await second.capture.stop();
    expect(sent.filter((m) => m === 'Network.disable')).toHaveLength(1);
  });

  it('取体超过等待上限：交出的记录标为未取到，晚到的结果不再改动', async () => {
    let finish!: (value: unknown) => void;
    responses['Network.getResponseBody'] = () => new Promise((resolve) => { finish = resolve; });
    const { capture } = await attached();
    sendRequest(1, 'slow', 101);
    emit(1, 'Network.responseReceived', { requestId: 'slow', response: { status: 200, mimeType: 'application/json', headers: {} } });
    emit(1, 'Network.loadingFinished', { requestId: 'slow', timestamp: 101.2, encodedDataLength: 10 });
    const log = await capture.stop();
    expect(log.entries[0].responseBody).toMatchObject({ omitted: 'unavailable' });
    finish({ body: '{"n":2}', base64Encoded: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log.entries[0].responseBody).toMatchObject({ omitted: 'unavailable' });
  }, 15000);

  it('新一轮正在打开 Network 域时旧一轮停止：不关域', async () => {
    const first = await attached();
    let finishEnable!: () => void;
    responses['Network.enable'] = () => new Promise<void>((resolve) => { finishEnable = resolve; });
    const second = new CdpNetworkCapture(START, () => {});
    second.observe(1, 'https://app.test/');
    await vi.waitFor(() => expect(finishEnable).toBeTypeOf('function'));
    await first.capture.stop();
    expect(sent).not.toContain('Network.disable');
    finishEnable();
    await vi.waitFor(() => expect(second.state).toBe('active'));
    await second.stop();
    expect(sent.filter((m) => m === 'Network.disable')).toHaveLength(1);
  });

  it('打开 Network 域途中停止：仍由这次连接关域并释放（连接可能被手机模拟继续持有）', async () => {
    let finishEnable!: () => void;
    responses['Network.enable'] = () => new Promise<void>((resolve) => { finishEnable = resolve; });
    const capture = new CdpNetworkCapture(START, () => {});
    capture.observe(1, 'https://app.test/');
    await vi.waitFor(() => expect(finishEnable).toBeTypeOf('function'));
    await capture.stop();
    expect(sent.at(-1)).toBe('Network.disable');
    expect(leases.get(1)!.release).toHaveBeenCalledTimes(1);
    finishEnable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(leases.get(1)!.release).toHaveBeenCalledTimes(1);
  });

  it('打开 Network 域途中被断开：计数撤销，之后的采集停止时照常关域', async () => {
    let finishEnable!: () => void;
    responses['Network.enable'] = () => new Promise<void>((resolve) => { finishEnable = resolve; });
    const capture = new CdpNetworkCapture(START, () => {});
    capture.observe(1, 'https://app.test/');
    await vi.waitFor(() => expect(finishEnable).toBeTypeOf('function'));
    leases.get(1)!.handlers.onDetach!('target_closed');
    finishEnable();
    await capture.stop();
    delete responses['Network.enable'];
    const next = await attached();
    await next.capture.stop();
    expect(sent.filter((m) => m === 'Network.disable')).toHaveLength(1);
  });

  it('重定向后旧一跳的请求体超时未取到：不给新一跳补「未取到」标记', async () => {
    responses['Network.getRequestPostData'] = () => new Promise(() => {});
    const { capture } = await attached();
    sendRequest(1, 'redir', 101, {
      request: { method: 'POST', url: 'https://api.test/login', headers: { 'Content-Type': 'application/json' }, hasPostData: true },
    });
    sendRequest(1, 'redir', 101.1, {
      request: { method: 'GET', url: 'https://api.test/home', headers: {} },
      redirectResponse: { status: 303 },
    });
    const log = await capture.stop();
    expect(log.entries[0].requestBody).toBeUndefined();
  }, 15000);
});

import { describe, expect, it } from 'vitest';
import { buildHar } from './har';
import type { NetworkEntry, NetworkLog } from './network-types';

const entry = (overrides: Partial<NetworkEntry> = {}): NetworkEntry => ({
  id: 'n1',
  t: 1500,
  tabId: 1,
  type: 'fetch',
  method: 'POST',
  url: 'https://api.test/orders?page=2',
  requestHeaders: [{ name: 'Content-Type', value: 'application/json' }],
  requestBody: { mimeType: 'application/json', text: '{"sku":"a"}', size: 11 },
  status: 201,
  statusText: 'Created',
  responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
  responseBody: { mimeType: 'application/json', text: '{"id":7}', size: 8, transferSize: 5 },
  durationMs: 120,
  ...overrides,
});

const log = (entries: NetworkEntry[], extra: Partial<NetworkLog> = {}): NetworkLog => ({
  state: 'active',
  entries,
  filteredCount: 0,
  ...extra,
});

describe('buildHar', () => {
  it('生成合法的 HAR 1.2，多行缩进，每条带 _cebianId', () => {
    const text = buildHar(log([entry()]), Date.UTC(2026, 9, 4, 0, 0, 0), '1.9.0');
    expect(text.split('\n').length).toBeGreaterThan(20);
    const har = JSON.parse(text);
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator).toEqual({ name: 'Cebian', version: '1.9.0' });
    const [e] = har.log.entries;
    expect(e._cebianId).toBe('n1');
    expect(e.startedDateTime).toBe('2026-10-04T00:00:01.500Z');
    expect(e.request).toMatchObject({
      method: 'POST',
      url: 'https://api.test/orders?page=2',
      queryString: [{ name: 'page', value: '2' }],
      postData: { mimeType: 'application/json', text: '{"sku":"a"}' },
    });
    expect(e.response).toMatchObject({ status: 201, bodySize: 5, content: { mimeType: 'application/json', text: '{"id":7}', size: 8 } });
    expect(e.time).toBe(120);
    expect(e.comment).toBeUndefined();
  });

  it('请求侧 bodySize 用已知的传输大小', () => {
    const har = JSON.parse(buildHar(log([entry({
      requestBody: { mimeType: 'application/json', text: '{}', size: 1000, transferSize: 50 },
    })]), 0, '1'));
    expect(har.log.entries[0].request.bodySize).toBe(50);
  });

  it('传输大小未知时 bodySize 为 -1；GET 请求没有 postData', () => {
    const har = JSON.parse(buildHar(log([entry({
      method: 'GET',
      requestBody: undefined,
      responseBody: { mimeType: 'application/json', text: '{}', size: 2 },
    })]), 0, '1'));
    expect(har.log.entries[0].request.postData).toBeUndefined();
    expect(har.log.entries[0].response.bodySize).toBe(-1);
    expect(har.log.entries[0].response.content.size).toBe(2);
  });

  it('重定向链与请求体省略原因写进条目', () => {
    const har = JSON.parse(buildHar(log([entry({
      redirects: [{ url: 'https://api.test/login', status: 302 }],
      requestBody: { mimeType: 'application/octet-stream', omitted: 'binary', size: 100 },
    })]), 0, '1'));
    expect(har.log.entries[0]._redirects).toEqual([{ url: 'https://api.test/login', status: 302 }]);
    expect(har.log.entries[0].comment).toMatch(/Request body not recorded: binary/);
  });

  it('录制结束时还没有响应的请求写明，不显得像失败', () => {
    const har = JSON.parse(buildHar(log([entry({ status: undefined, durationMs: undefined, responseBody: undefined })]), 0, '1'));
    expect(har.log.entries[0].comment).toMatch(/No response before the recording ended/);
  });

  it('响应体未录到时写明原因，失败的请求写明错误', () => {
    const har = JSON.parse(buildHar(log([
      entry({ id: 'big', responseBody: { mimeType: 'application/json', omitted: 'too_large', size: 900_000 } }),
      entry({ id: 'fail', status: undefined, responseBody: undefined, error: 'net::ERR_FAILED' }),
    ]), 0, '1'));
    expect(har.log.entries[0].response.content.text).toBeUndefined();
    expect(har.log.entries[0].comment).toMatch(/larger than the recording limit/);
    expect(har.log.entries[1].response.status).toBe(0);
    expect(har.log.entries[1].comment).toMatch(/ERR_FAILED/);
  });

  it('WebSocket 消息按 DevTools 认的 _webSocketMessages 输出', () => {
    const har = JSON.parse(buildHar(log([entry({
      type: 'websocket',
      method: 'GET',
      requestBody: undefined,
      messages: [{ direction: 'sent', t: 2000, data: 'ping' }, { direction: 'received', t: 2100, data: '[binary frame]', binary: true }],
      messagesTruncated: true,
    })]), 1_000_000, '1'));
    expect(har.log.entries[0]._webSocketMessages).toEqual([
      { type: 'send', time: 1002, opcode: 1, data: 'ping' },
      { type: 'receive', time: 1002.1, opcode: 2, data: '[binary frame]' },
    ]);
    expect(har.log.entries[0].comment).toMatch(/first messages/);
  });

  it('整体说明里写明中止、不可用的标签页、截断、过滤与打码', () => {
    const har = JSON.parse(buildHar(log([], {
      state: 'aborted',
      abortedAt: 42_000,
      filteredCount: 3,
      truncated: 'size_limit',
      unavailableTabs: [{ tabId: 9, reason: 'another debugger is attached' }],
    }), 0, '1'));
    expect(har.log.comment).toMatch(/stopped by the user 42s/);
    expect(har.log.comment).toMatch(/Tab 9 could not be recorded: another debugger is attached/);
    expect(har.log.comment).toMatch(/size or entry limit/);
    expect(har.log.comment).toMatch(/3 analytics/);
    expect(har.log.comment).toMatch(/redacted/);
  });

  it('没有中止时刻也写明被用户中止；整次不可用时写明原因', () => {
    expect(JSON.parse(buildHar(log([], { state: 'aborted' }), 0, '1')).log.comment).toMatch(/stopped by the user\./);
    expect(JSON.parse(buildHar(log([], { state: 'unavailable', unavailableReason: 'permission denied' }), 0, '1')).log.comment)
      .toMatch(/unavailable: permission denied/);
  });
});

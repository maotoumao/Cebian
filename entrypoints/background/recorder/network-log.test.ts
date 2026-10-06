import { describe, expect, it } from 'vitest';
import {
  NETWORK_BODY_MAX,
  NETWORK_MAX_ENTRIES,
  NETWORK_STREAM_MESSAGES_MAX,
  NETWORK_TOTAL_MAX,
} from '@/lib/recorder/constants';
import { NetworkLogBuilder, type NewRequest } from './network-log';

const START = 1_000_000;

function request(overrides: Partial<NewRequest> = {}): NewRequest {
  return {
    tabId: 1,
    type: 'fetch',
    method: 'GET',
    url: 'https://api.test/items?page=1',
    at: START + 10,
    headers: [],
    ...overrides,
  };
}

describe('NetworkLogBuilder', () => {
  it('登记请求时就地打码 URL 与请求头，埋点请求只计入过滤数', () => {
    const log = new NetworkLogBuilder(START);
    const entry = log.addRequest(request({
      url: 'https://api.test/cb?access_token=LEAK6rQ8&page=1',
      headers: [{ name: 'Authorization', value: 'Bearer LEAK6rQ8' }],
    }))!;
    expect(entry.url).not.toContain('LEAK6rQ8');
    expect(entry.requestHeaders[0].value).not.toContain('LEAK6rQ8');
    expect(log.addRequest(request({ url: 'https://www.google-analytics.com/g/collect?v=2' }))).toBeUndefined();
    expect(log.toLog()).toMatchObject({ filteredCount: 1, entries: [{ id: entry.id }] });
  });

  it('请求数到上限后停止录网络并标注', () => {
    const log = new NetworkLogBuilder(START);
    for (let i = 0; i < NETWORK_MAX_ENTRIES; i++) log.addRequest(request());
    expect(log.addRequest(request())).toBeUndefined();
    expect(log.toLog()).toMatchObject({ truncated: 'entry_limit' });
    expect(log.count).toBe(NETWORK_MAX_ENTRIES);
  });

  it('正文：二进制、超过单体上限、无法可靠打码的格式都只记省略原因；记录的内容已打码', () => {
    const log = new NetworkLogBuilder(START);
    expect(log.body('PNG', 'image/png')).toMatchObject({ omitted: 'binary' });
    expect(log.body('x'.repeat(NETWORK_BODY_MAX + 1), 'application/json')).toMatchObject({ omitted: 'too_large' });
    expect(log.body('<p>LEAK6rQ8</p>', 'text/html')).toMatchObject({ omitted: 'unsupported' });
    expect(log.body(undefined, 'application/json')).toMatchObject({ omitted: 'unavailable' });
    const body = log.body('{"password":"LEAK6rQ8","n":1}', 'application/json', 20);
    expect(body.text).not.toContain('LEAK6rQ8');
    expect(body).toMatchObject({ size: 29, transferSize: 20 });
  });

  it('网络数据总量到上限后不再记录正文并标注', () => {
    const log = new NetworkLogBuilder(START);
    const chunk = JSON.stringify({ data: 'a'.repeat(NETWORK_BODY_MAX - 20) });
    let last;
    for (let i = 0; i * chunk.length <= NETWORK_TOTAL_MAX; i++) last = log.body(chunk, 'application/json');
    expect(last).toMatchObject({ omitted: 'too_large' });
    expect(log.toLog().truncated).toBe('size_limit');
    expect(log.accepting).toBe(false);
  });

  it('被替换掉的正文退回额度', () => {
    const log = new NetworkLogBuilder(START);
    const chunk = JSON.stringify({ data: 'a'.repeat(NETWORK_BODY_MAX - 20) });
    // 反复记录并丢弃：实际保存的始终只有一份，不应触发总量上限
    for (let i = 0; i * chunk.length <= NETWORK_TOTAL_MAX * 2; i++) {
      log.discardBody(log.body(chunk, 'application/json'));
    }
    expect(log.toLog().truncated).toBeUndefined();
  });

  it('取响应体之前先按类型与已知大小判断', () => {
    const log = new NetworkLogBuilder(START);
    expect(log.shouldFetchBody('application/json', 100)).toBe(true);
    expect(log.shouldFetchBody('font/woff2', 100)).toMatchObject({ omitted: 'binary' });
    expect(log.shouldFetchBody(undefined, 100)).toMatchObject({ omitted: 'binary' });
    expect(log.shouldFetchBody('application/json', NETWORK_BODY_MAX + 1, 40)).toMatchObject({ omitted: 'too_large', transferSize: 40 });
  });

  it('multipart 表单交给专用规则逐字段打码，不当成二进制丢掉', () => {
    const log = new NetworkLogBuilder(START);
    const body = '--B\r\nContent-Disposition: form-data; name="title"\r\n\r\nhello\r\n--B--\r\n';
    expect(log.body(body, 'multipart/form-data; boundary=B').text).toContain('hello');
  });

  it('总量按保存的内容（打码、截断后）的 UTF-8 字节计算', () => {
    const log = new NetworkLogBuilder(START);
    // 中文每字 3 字节：按字符数计会低估成三分之一，永远到不了上限
    const message = JSON.stringify({ text: '中'.repeat(400) });
    const perMessage = new TextEncoder().encode(message).length;
    let stored = 0;
    while (log.accepting) {
      const entry = log.addRequest(request({ type: 'websocket' }))!;
      for (let i = 0; i < NETWORK_STREAM_MESSAGES_MAX && log.accepting; i++) {
        log.addMessage(entry, 'received', START, message);
        if (!entry.messagesTruncated) stored = stored + perMessage;
      }
    }
    expect(log.toLog().truncated).toBe('size_limit');
    expect(stored).toBeLessThanOrEqual(NETWORK_TOTAL_MAX);
    expect(stored).toBeGreaterThan(NETWORK_TOTAL_MAX - perMessage);
  });

  it('EventSource 消息按 SSE 规则打码：JSON 与结束标记保留，其它文本整份打码', () => {
    const log = new NetworkLogBuilder(START);
    const entry = log.addRequest(request({ type: 'eventsource' }))!;
    log.addMessage(entry, 'received', START, '[DONE]');
    log.addMessage(entry, 'received', START, '42');
    log.addMessage(entry, 'received', START, 'https://a.test/reset-password/LEAK6rQ8');
    expect(entry.messages!.map((m) => m.data)).toEqual(['[DONE]', '42', '[redacted]']);
  });

  it('推送消息：先打码再截断，socket.io 的数字前缀保留，超过条数只标注', () => {
    const log = new NetworkLogBuilder(START);
    const entry = log.addRequest(request({ type: 'websocket' }))!;
    log.addMessage(entry, 'received', START + 20, '42["login",{"token":"LEAK6rQ8"}]');
    log.addMessage(entry, 'sent', START + 30, 'plain text LEAK6rQ8');
    log.addMessage(entry, 'received', START + 40, '[binary frame]', true);
    expect(entry.messages![0].data.startsWith('42[')).toBe(true);
    expect(entry.messages![0].data).not.toContain('LEAK6rQ8');
    expect(entry.messages![1].data).not.toContain('LEAK6rQ8');
    expect(entry.messages![2]).toMatchObject({ binary: true, t: 40 });
    for (let i = 0; i < NETWORK_STREAM_MESSAGES_MAX; i++) log.addMessage(entry, 'received', START + 50, '{}');
    expect(entry.messages).toHaveLength(NETWORK_STREAM_MESSAGES_MAX);
    expect(entry.messagesTruncated).toBe(true);
  });

  it('状态：中止后不再接受新请求；从没连上过且有失败原因时为不可用', () => {
    const aborted = new NetworkLogBuilder(START);
    aborted.markAttached(1);
    aborted.abort(START + 500);
    expect(aborted.addRequest(request())).toBeUndefined();
    expect(aborted.toLog()).toMatchObject({ state: 'aborted', abortedAt: 500 });

    const unavailable = new NetworkLogBuilder(START);
    unavailable.markTabUnavailable(1, 'Another debugger is attached');
    expect(unavailable.toLog()).toMatchObject({ state: 'unavailable', unavailableReason: 'Another debugger is attached' });

    const partial = new NetworkLogBuilder(START);
    partial.markAttached(1);
    partial.markTabUnavailable(2, 'busy');
    expect(partial.toLog()).toMatchObject({ state: 'active', unavailableTabs: [{ tabId: 2, reason: 'busy' }] });
  });

  it('条目按发生时刻排序', () => {
    const log = new NetworkLogBuilder(START);
    log.addRequest(request({ at: START + 300 }));
    log.addRequest(request({ at: START + 100 }));
    expect(log.toLog().entries.map((e) => e.t)).toEqual([100, 300]);
  });
});

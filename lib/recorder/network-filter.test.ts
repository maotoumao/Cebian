import { describe, expect, it } from 'vitest';
import { fromCdpResourceType, fromWebRequestType, isTelemetryRequest, isTextMimeType } from './network-filter';

describe('录制类型', () => {
  it('CDP：只录文档、接口与推送流，其它类型（含 sendBeacon 的 Ping）不录', () => {
    expect(['Document', 'Fetch', 'XHR', 'EventSource', 'WebSocket'].map(fromCdpResourceType))
      .toEqual(['document', 'fetch', 'xhr', 'eventsource', 'websocket']);
    for (const type of ['Image', 'Stylesheet', 'Font', 'Media', 'Script', 'Ping', 'Other', undefined]) {
      expect(fromCdpResourceType(type)).toBeUndefined();
    }
  });

  it('Firefox：顶层文档、XHR/fetch 与 WebSocket 才录', () => {
    expect(fromWebRequestType('main_frame')).toBe('document');
    expect(fromWebRequestType('xmlhttprequest')).toBe('xhr');
    expect(fromWebRequestType('websocket')).toBe('websocket');
    for (const type of ['sub_frame', 'image', 'beacon', 'script', 'stylesheet', 'ping']) {
      expect(fromWebRequestType(type)).toBeUndefined();
    }
  });
});

describe('isTelemetryRequest', () => {
  it('匹配埋点主机及其子域名', () => {
    expect(isTelemetryRequest('https://www.google-analytics.com/g/collect?v=2')).toBe(true);
    expect(isTelemetryRequest('https://o123.ingest.sentry.io/api/1/envelope/')).toBe(true);
    expect(isTelemetryRequest('https://hm.baidu.com/hm.gif')).toBe(true);
    expect(isTelemetryRequest('https://region1.analytics.google.com/g/collect?v=2')).toBe(true);
  });

  it('不误伤业务接口：厂商自己的网页 / 接口、名字相近的域名、普通的 /collect 路径；非法 URL 不算', () => {
    expect(isTelemetryRequest('https://sentry.io/api/0/organizations/acme/projects/')).toBe(false);
    expect(isTelemetryRequest('https://us.posthog.com/api/projects/1/insights')).toBe(false);
    expect(isTelemetryRequest('https://analytics.google.com/analytics/web/')).toBe(false);
    expect(isTelemetryRequest('https://api.example.com/collect')).toBe(false);
    expect(isTelemetryRequest('https://notsentry.io/x')).toBe(false);
    expect(isTelemetryRequest('nope')).toBe(false);
  });
});

describe('isTextMimeType', () => {
  it('文本类读取，二进制跳过', () => {
    for (const mime of ['application/json', 'application/problem+json', 'text/html; charset=utf-8', 'application/xml', 'text/event-stream', 'application/graphql-response+json']) {
      expect(isTextMimeType(mime)).toBe(true);
    }
    for (const mime of ['application/x-ndjson', 'application/graphql', 'application/json; charset=utf-8', 'application/x-amz-json-1.1']) {
      expect(isTextMimeType(mime)).toBe(true);
    }
    for (const mime of ['image/png', 'application/octet-stream', 'application/octet-stream; name="payload.json"', 'application/pdf', 'font/woff2', undefined]) {
      expect(isTextMimeType(mime)).toBe(false);
    }
  });
});

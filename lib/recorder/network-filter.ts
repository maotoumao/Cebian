// 网络录制录哪些请求：只录能说明「网站怎么工作」的请求（页面文档、接口调用、推送流），
// 跳过静态资源，并把常见的埋点 / 监控请求计入过滤数而不录。

import { isTextualMime, mediaType } from '@/lib/content/mime';
import type { NetworkResourceType } from './network-types';

/**
 * CDP `Network.ResourceType` → 录制类型；不录的返回 undefined（含 `Ping`，即 sendBeacon 埋点）。
 * CDP 把 iframe 的文档也报成 `Document`，只录顶层文档由采集方按 frame 判断。
 */
function fromCdpResourceType(type: string | undefined): NetworkResourceType | undefined {
  switch (type) {
    case 'Document': return 'document';
    case 'Fetch': return 'fetch';
    case 'XHR': return 'xhr';
    case 'EventSource': return 'eventsource';
    case 'WebSocket': return 'websocket';
    default: return undefined;
  }
}

/**
 * Firefox `webRequest` 的 `ResourceType` → 录制类型。Firefox 不区分 fetch 与 XHR，统一记为 `xhr`；
 * `beacon`（sendBeacon 埋点）与 iframe 文档不录。
 */
function fromWebRequestType(type: string | undefined): NetworkResourceType | undefined {
  switch (type) {
    case 'main_frame': return 'document';
    case 'xmlhttprequest': return 'xhr';
    case 'websocket': return 'websocket';
    default: return undefined;
  }
}

/**
 * 常见埋点、监控、广告统计服务**专用于收数据**的主机（匹配本身或其子域名）。只列采集用的
 * 主机，不列厂商主域名：录制 Sentry、PostHog 等产品自己的网页时，它们的业务接口照常录。
 */
const TELEMETRY_HOSTS: readonly string[] = [
  'google-analytics.com',
  // GA4 的 fetch 兜底上报；分析后台本身在 analytics.google.com，不受影响
  'region1.analytics.google.com',
  'googletagmanager.com',
  'doubleclick.net',
  'googleadservices.com',
  'ingest.sentry.io',
  'ingest.us.sentry.io',
  'ingest.de.sentry.io',
  'in.hotjar.com',
  'content.hotjar.io',
  'api.segment.io',
  'api-js.mixpanel.com',
  'api2.amplitude.com',
  'api.eu.amplitude.com',
  'i.posthog.com',
  'c.clarity.ms',
  'bam.nr-data.net',
  'browser-intake-datadoghq.com',
  'browser-intake-datadoghq.eu',
  'notify.bugsnag.com',
  'sessions.bugsnag.com',
  'rs.fullstory.com',
  'heapanalytics.com',
  'r.lr-ingest.io',
  'bat.bing.com',
  'analytics.tiktok.com',
  'hm.baidu.com',
  'ulogs.umeng.com',
  'ynuf.aliapp.org',
];

/** 请求是否发往常见的埋点 / 监控服务。 */
function isTelemetryRequest(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return TELEMETRY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** 录制额外按文本读取的类型（`isTextualMime` 之外的接口常用类型）。 */
const EXTRA_TEXT_TYPES: ReadonlySet<string> = new Set([
  'application/graphql',
  'application/x-ndjson',
  'application/ndjson',
  'application/ecmascript',
  'application/x-javascript',
]);

/**
 * 响应体是否值得读取：只读文本类内容，图片、音视频、字体、压缩包等二进制一律跳过。
 * 先取出媒体类型再判断，避免 `application/octet-stream; name="a.json"` 这类参数被误判。
 */
function isTextMimeType(mimeType: string | undefined): boolean {
  const type = mediaType(mimeType);
  if (!type) return false;
  // 带 json 的私有类型也按文本读，如 AWS 的 application/x-amz-json-1.1
  return isTextualMime(type) || EXTRA_TEXT_TYPES.has(type) || type.includes('json');
}

// ─── 公开 API ───

export { fromCdpResourceType, fromWebRequestType, isTelemetryRequest, isTextMimeType };

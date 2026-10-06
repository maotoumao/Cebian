// 网络录制里读取请求 / 响应头的小工具（采集端与 HAR 生成共用）。

import type { NetworkHeader } from './network-types';

/** 把 `{ name: value }` 形式的头部（CDP）转成数组。 */
function headerList(headers: Record<string, unknown> | undefined): NetworkHeader[] {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

/** 按名字（不区分大小写，`name` 传小写）取头部的值。 */
function headerValue(headers: NetworkHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name)?.value;
}

function contentType(headers: NetworkHeader[] | undefined): string | undefined {
  return headerValue(headers, 'content-type');
}

/** 头部里声明的正文字节数；没有或不合法时返回 undefined。 */
function contentLength(headers: NetworkHeader[] | undefined): number | undefined {
  const raw = headerValue(headers, 'content-length');
  const value = raw == null || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

// ─── 公开 API ───

export { contentLength, contentType, headerList, headerValue };

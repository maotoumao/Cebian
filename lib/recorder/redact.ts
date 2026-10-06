// 网络录制的打码：在后台采集时就地执行，原始的敏感值不离开后台、不进附件、不写进 HAR。
// 判断规则在 `secret-hints.ts`，URL、字符串值与 JSON 的改写在 `redact-values.ts`；这里按头部与
// 正文格式组合。
//
// 正文只保留**能可靠打码的格式**：JSON（含 NDJSON、SSE 的数据）、表单、multipart、整段是
// URL 的文本。HTML、XML、YAML、脚本、GraphQL 原文、无结构的纯文本等无法逐字段打码的格式
// 一律不记（`redactBody` 返回 undefined），宁缺毋漏；打码过程出错也同样不记。

import { mediaType } from '@/lib/content/mime';
import { escapeRegExp } from '@/lib/utils';
import type { NetworkHeader } from './network-types';
import {
  ANTI_HIJACK_PREFIX,
  REDACTED,
  redactJsonText,
  redactParams,
  redactStringValue,
  redactUrl,
} from './redact-values';
import {
  hasSecretHints,
  hasStructuralHints,
  isSensitiveName,
  isSensitiveEncodedName,
  looksLikeJson,
  looksLikeUrl,
} from './secret-hints';

/** 一律打码的请求 / 响应头（小写）；名字本身像凭据的头（如 `X-Token`）另按字段名规则判断。 */
const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-amz-security-token',
]);

/** 整个值就是一个 URL（可能是相对地址）的头。 */
const URL_HEADERS: ReadonlySet<string> = new Set(['referer', 'location', 'content-location']);

/**
 * 取值是名字 / 指令列表的头：值里出现 `Cookie`、`Authorization` 这类词很正常，只按结构化
 * 规则（敏感名字的赋值等）检查，不按词打码；这些头的名字本身（如
 * `Access-Control-Allow-Credentials`）也不按凭据名判断。其它头按自由文本处理。
 */
const NAME_LIST_HEADERS: ReadonlySet<string> = new Set([
  'accept', 'accept-ch', 'accept-encoding', 'accept-language', 'access-control-allow-credentials',
  'access-control-allow-headers', 'access-control-allow-methods', 'access-control-allow-origin',
  'access-control-expose-headers', 'access-control-max-age', 'access-control-request-headers',
  'access-control-request-method', 'allow', 'cache-control', 'connection', 'content-encoding',
  'content-language', 'content-length', 'content-security-policy', 'content-security-policy-report-only',
  'content-type', 'critical-ch', 'feature-policy',
  'permissions-policy', 'pragma', 'timing-allow-origin', 'transfer-encoding', 'vary',
]);

/**
 * 策略类的头：每一项以功能名开头（`otp-credentials=(self)`、`camera 'none'`），功能名不是
 * 参数名，检查前先去掉，只检查后面的来源列表。
 */
const POLICY_HEADERS: ReadonlySet<string> = new Set(['permissions-policy', 'feature-policy', 'document-policy']);

/**
 * 头部值里的 URL 引用：尖括号里的完整引用（Link 头，可以是相对地址、含 `;` `,`），或裸的
 * 绝对 URL（到空白、双引号或尖括号为止：合法 URL 里只有这些字符必须转义；单引号可以出现在
 * 查询里，不能在那里截断）。
 */
const HEADER_URL = /<([^<>]*)>|(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s<>"]+/gi;

/** SSE 流里只保留这种全大写的结束标记（`[DONE]`）；其它不是 JSON 的数据无法判断，整份打码。 */
const STREAM_MARKER = /^\[[A-Z_]{1,16}\]$/;

/** HTTP 头的名字（token 字符）。 */
const HEADER_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]*:(.*)$/;

/** multipart 分段里正文仍是原文的传输编码；quoted-printable、base64 等编码过的分段按无法检查处理。 */
const IDENTITY_TRANSFER_ENCODINGS: ReadonlySet<string> = new Set(['7bit', '8bit', 'binary']);

// ─── 头部 ───

/** Refresh 头：`5; url=https://…`（分隔符、空白、引号都可能有，url 可能是相对地址）。 */
function redactRefresh(value: string): string {
  // 先去掉尾部空白再匹配：懒惰匹配的目标与尾部空白相邻时会回溯成平方级
  const body = value.trimEnd();
  const trailing = value.slice(body.length);
  const match = /^(\s*[\d.]*\s*[;,]?\s*(?:url\s*=\s*)?)(["']?)(.*)$/is.exec(body);
  if (!match || !match[3]) return value;
  const [, prefix, quote] = match;
  let target = match[3];
  const closing = quote && target.endsWith(quote) ? quote : '';
  if (closing) target = target.slice(0, -1);
  // 目标不像 URL（`0; password: …`）：按自由文本检查
  if (!looksLikeUrl(target.trim()) && hasSecretHints(target)) return REDACTED;
  return `${prefix}${quote}${redactUrl(target)}${closing}${trailing}`;
}

/**
 * 其它头：内嵌的 URL 引用打码；URL 之外的部分还有凭据迹象就整个值打码（名字列表类的头只看
 * 结构化迹象，其余按自由文本）。
 */
function redactHeaderValue(name: string, value: string): string {
  // 尖括号里的内容确实像 URL 才按 URL 处理并从剩余部分挖掉，否则留给剩余部分一起检查。
  // Link 头的尖括号里按规范就是 URI 引用（`cb?x=1`、`#a=1` 这类相对写法也算），只要没有空白
  const isUrlRef = (ref: string | undefined) =>
    ref == null || looksLikeUrl(ref.trim()) || (name === 'link' && /^\S+$/.test(ref));
  const out = value.replace(HEADER_URL, (whole, ref: string | undefined) => {
    if (!isUrlRef(ref)) return whole;
    return ref != null ? `<${redactUrl(ref)}>` : redactUrl(whole);
  });
  let rest = value.replace(HEADER_URL, (whole, ref: string | undefined) => (isUrlRef(ref) ? ' ' : whole));
  if (POLICY_HEADERS.has(name)) rest = rest.replace(/(^|[,;])\s*[\w-]+\s*=?/g, '$1');
  // CSP 的 `'nonce-…'` / `'sha256-…'` 来源是每次响应生成的随机值或摘要，不是凭据
  if (name.startsWith('content-security-policy')) rest = rest.replace(/'(?:nonce|sha\d+)-[^']*'/gi, ' ');
  const risky = NAME_LIST_HEADERS.has(name) ? hasStructuralHints(rest) : hasSecretHints(rest);
  return risky ? REDACTED : out;
}

function redactHeader(h: NetworkHeader): NetworkHeader {
  const name = h.name.toLowerCase();
  const sensitive =
    SENSITIVE_HEADERS.has(name)
    || (!NAME_LIST_HEADERS.has(name)
      && (isSensitiveName(h.name, 'param')
        || isSensitiveName(h.name.replace(/^x-/i, ''), 'param')
        // 以 key 结尾的自定义头多是 API Key（`x-functions-key`）；WebSocket 握手的随机值除外
        || (/key$/.test(name) && name !== 'sec-websocket-key')));
  if (sensitive) return { name: h.name, value: REDACTED };
  if (URL_HEADERS.has(name)) return { name: h.name, value: redactUrl(h.value) };
  if (name === 'refresh') return { name: h.name, value: redactRefresh(h.value) };
  return { name: h.name, value: redactHeaderValue(name, h.value) };
}

function redactHeaders(headers: NetworkHeader[]): NetworkHeader[] {
  return headers.map((h) => {
    try {
      return redactHeader(h);
    } catch {
      return { name: h.name, value: REDACTED };
    }
  });
}

// ─── 正文 ───

/** MIME 类型里 `;` 之后的参数部分。 */
function mimeParameters(mimeType: string | undefined): Map<string, string> {
  const semicolon = (mimeType ?? '').indexOf(';');
  return (semicolon < 0 ? undefined : parseParameters(mimeType!.slice(semicolon))) ?? new Map();
}

/** 解析 `type; a=1; b="x;y"` 里的参数（尊重引号）。同名参数出现多次时返回 undefined（有歧义）。 */
function parseParameters(value: string): Map<string, string> | undefined {
  const params = new Map<string, string>();
  const re = /;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  for (const match of value.matchAll(re)) {
    const key = match[1].toLowerCase();
    if (params.has(key)) return undefined;
    params.set(key, (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1').trim());
  }
  return params;
}

function quoteParameter(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&').replace(/[\r\n]/g, ' ')}"`;
}

/** multipart 分段头（已展开折行）。有无法解析的行、同名头重复时返回 undefined（有歧义）。 */
function parsePartHeaders(head: string): Map<string, string> | undefined {
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    if (!line) continue;
    const match = HEADER_LINE.exec(line);
    if (!match) return undefined;
    const name = match[1].toLowerCase();
    if (headers.has(name)) return undefined;
    headers.set(name, match[2].trim());
  }
  return headers;
}

/**
 * 一个 multipart 分段（分隔行之后、下一个分隔行之前的内容，以换行开头）。分段头只按解析
 * 结果重建 Content-Disposition 与 Content-Type，其余头不记；认不出字段名时整段打码。
 */
function redactPart(part: string): string {
  const separator = /\r?\n\r?\n/.exec(part);
  const headers = separator ? parsePartHeaders(part.slice(0, separator.index)) : undefined;
  const disposition = headers?.get('content-disposition');
  const params = disposition != null ? parseParameters(`;${disposition.replace(/^[^;]*/, '')}`) : undefined;
  const name = params?.get('name');
  if (!separator || name == null) return part.trim() ? `\r\n${REDACTED}` : part;

  const body = part.slice(separator.index + separator[0].length);
  const filename = params!.get('filename') ?? params!.get('filename*');
  const type = mediaType(headers!.get('content-type'));
  const transferEncoding = headers!.get('content-transfer-encoding')?.toLowerCase();
  const safeName = redactStringValue(name, 0).value;
  let redacted: string;
  if (safeName !== name || isSensitiveEncodedName(name)) redacted = REDACTED;
  else if (filename != null) redacted = '[file content not recorded]';
  else if (transferEncoding != null && !IDENTITY_TRANSFER_ENCODINGS.has(transferEncoding)) redacted = REDACTED;
  else if (!(type === '' || type === 'text/plain' || type.includes('json'))) redacted = REDACTED;
  else if (type.includes('json')) redacted = redactJsonText(body) ?? REDACTED;
  else redacted = redactStringValue(body, 0).value;

  let head = `\r\nContent-Disposition: form-data; name=${quoteParameter(safeName)}`;
  if (filename != null) head += `; filename=${quoteParameter(redactStringValue(filename, 0).value)}`;
  if (/^[\w.+-]+\/[\w.+-]+$/.test(type)) head += `\r\nContent-Type: ${type}`;
  return `${head}\r\n\r\n${redacted}`;
}

/**
 * multipart 表单：按位于行首的分隔行切分（RFC 2046），字段名取 Content-Disposition 的
 * `name` 参数。敏感字段内容打码；文件内容不记；声明了 JSON 类型的分段按 JSON 打码，解析
 * 不了就整段打码；声明了其它非纯文本类型的分段整段打码；其余按字符串值规则处理。首个分隔行
 * 之前的前言与结束分隔行之后的尾声不属于任何字段，直接丢弃。分隔符本身会原样出现在输出里，
 * 它带有凭据迹象时整份不记（返回 undefined）。
 */
function redactMultipart(text: string, boundary: string): string | undefined {
  if (hasSecretHints(boundary)) return undefined;
  const delimiter = new RegExp(`(^|\\r?\\n)--${escapeRegExp(boundary)}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g');
  const matches = [...text.matchAll(delimiter)];
  if (matches.length === 0) throw new Error('multipart body without delimiters');
  let out = '';
  for (const [i, match] of matches.entries()) {
    out += i === 0 ? match[0].replace(/^\r?\n/, '') : match[0];
    if (match[2]) return `${out}\r\n`;
    const start = match.index! + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    out += redactPart(text.slice(start, end));
  }
  return out;
}

/** 流式数据（NDJSON 的一行、SSE 的一份 data）：任何 JSON 值都处理；`[DONE]` 这类标记保留；其余整份打码。 */
function redactStreamData(data: string): string {
  if (!data.trim()) return data;
  const redacted = redactJsonText(data);
  if (redacted !== undefined) return redacted;
  return STREAM_MARKER.test(data.trim()) ? data : REDACTED;
}

/** NDJSON：每行一个 JSON 值（保留原有换行）。 */
function redactNdjson(text: string): string {
  return text.split(/(\r\n|\r|\n)/).map((line, i) => (i % 2 === 1 ? line : redactStreamData(line))).join('');
}

/** SSE 除 data 以外的一行：`event` 有凭据迹象时打码，`id` 只保留数字形式，`retry` 只保留纯数字，注释与未知字段丢弃。 */
function redactEventField(line: string): string | undefined {
  const colon = line.indexOf(':');
  const field = colon < 0 ? line : line.slice(0, colon);
  const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
  if (field === 'retry') return /^\d+$/.test(value) ? line : undefined;
  if (field === 'event') return hasSecretHints(value) ? `event: ${REDACTED}` : line;
  if (field === 'id') return /^[\d.:-]*$/.test(value) ? line : `id: ${REDACTED}`;
  return undefined;
}

/**
 * SSE：按规范解析（BOM、CR / LF / CRLF 换行、空行分隔事件、多行 `data:` 拼接）。每个事件的
 * data 拼成一份打码，打码后有变化就换成一组新的 data 行；其它字段见 `redactEventField`。
 * 输出统一用 LF 换行。
 */
function redactEventStream(text: string): string {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const out: string[] = [];
  let event: string[] = [];
  const isData = (line: string) => /^data(?::|$)/.test(line);
  const flush = () => {
    const dataLines = event.filter(isData);
    const first = event.findIndex(isData);
    const kept = event.flatMap((line) => {
      if (isData(line)) return [];
      const field = redactEventField(line);
      return field != null ? [field] : [];
    });
    if (dataLines.length > 0) {
      const data = dataLines.map((line) => line.replace(/^data:? ?/, '')).join('\n');
      const redacted = redactStreamData(data);
      const rebuilt = redacted === data ? dataLines : redacted.split('\n').map((line) => `data: ${line}`);
      // data 行放回第一条 data 原来的位置（之前的非 data 行数）
      const before = event.slice(0, first).filter((line) => redactEventField(line) != null).length;
      kept.splice(before, 0, ...rebuilt);
    }
    out.push(...kept);
    event = [];
  };
  for (const line of lines) {
    if (line === '') {
      flush();
      out.push('');
    } else {
      event.push(line);
    }
  }
  flush();
  return out.join('\n');
}

/** `a=1&b=2`（值里可以有空格）。 */
function looksLikeAmpersandForm(text: string): boolean {
  return /^[^=&\s]+=[^&\r\n]*(?:&[^=&\s]+=[^&\r\n]*)*$/.test(text.trim());
}

/** 浏览器 `enctype="text/plain"` 的表单：每行 `name=value`。 */
function looksLikeLineForm(text: string): boolean {
  const fields = text.split(/\r\n|\r|\n/).filter((line) => line !== '');
  return fields.length > 0 && fields.every((line) => /^[^=]+=/.test(line));
}

/** 能可靠打码就返回打码后的文本，否则返回 undefined（调用方不记这份正文）。 */
function redactBodyUnsafe(text: string, mimeType: string | undefined): string | undefined {
  if (!text.trim()) return text;
  const type = mediaType(mimeType);
  if (type === 'text/event-stream') return redactEventStream(text);
  if (type === 'application/x-ndjson' || type === 'application/ndjson') return redactNdjson(text);
  if (type === 'application/x-www-form-urlencoded') {
    // jQuery 等把 JSON 字符串当表单发送时仍带表单类型：能按 JSON 解析就按 JSON 处理
    const json = looksLikeJson(text) ? redactJsonText(text) : undefined;
    return json ?? redactParams(text, 0).value;
  }
  if (type === 'multipart/form-data') {
    const boundary = mimeParameters(mimeType).get('boundary');
    return boundary ? redactMultipart(text, boundary) : undefined;
  }
  if (type.includes('json')) return redactJsonText(text);
  if (type && type !== 'text/plain') return undefined;
  // 未声明类型或纯文本：只认得出结构的才记
  if (looksLikeJson(text) || ANTI_HIJACK_PREFIX.test(text)) {
    const json = redactJsonText(text);
    if (json !== undefined) return json;
  }
  if (looksLikeUrl(text.trim())) return redactUrl(text);
  // 纯文本表单里字段值可以含 `&` 与换行，分不清哪段属于敏感字段：有凭据迹象就不记
  if (looksLikeAmpersandForm(text) || looksLikeLineForm(text)) return hasSecretHints(text) ? undefined : text;
  return undefined;
}

/**
 * 请求体 / 响应体打码。返回打码后的文本；格式无法可靠打码（HTML、XML、脚本、无结构文本等）
 * 或打码出错时返回 undefined，调用方据此不记这份正文。mimeType 不明时，按内容识别 JSON、
 * 表单与 URL。
 */
function redactBody(text: string, mimeType?: string): string | undefined {
  try {
    return redactBodyUnsafe(text, mimeType);
  } catch {
    return undefined;
  }
}

// ─── 公开 API ───

export { redactBody, redactHeaders, redactStreamData };

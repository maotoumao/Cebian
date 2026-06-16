// WebDAV 传输层：在 Settings 页面用 fetch 直连 WebDAV 服务端（凭 <all_urls> host
// 权限绕过 CORS），把远程目录当作一个「快照库」操作——测试连接 / 建目录 / 列出 /
// 上传 / 下载 / 删除。
//
// 这一层只做传输，不认识备份语义：每个快照的内容就是 archive.ts 产出的 zip 字节，
// 由调用方（BackupSection）负责打包 / 解包。XML 解析用页面环境的 DOMParser；
// background SW 没有 DOMParser，这也是整条编排放在页面跑的原因之一（见技术设计）。

import type { WebDavConfig } from '@/lib/persistence/storage';
import { t } from '@/lib/i18n';

/** 远程快照库里的一个快照（一个 .zip 文件）。 */
interface WebDavSnapshot {
  /** 远程文件名，如 `备份 2026-06-09 14-30.zip`（由用户填的备份名净化而来）。也是下载 /
   *  删除的 key。 */
  name: string;
  /** 文件字节数；服务端未返回 `getcontentlength` 时为 undefined。 */
  size?: number;
  /** 服务端 `getlastmodified`（毫秒时间戳）；未返回 / 解析失败时为 undefined。 */
  lastModified?: number;
}

/** WebDAV 操作失败的归类错误码，供 UI 给出明确反馈。 */
type WebDavErrorCode =
  // fetch 抛错：无法连接 / DNS / TLS / 跨域被拦
  | 'network'
  // 请求超时：服务器在超时窗口内无响应
  | 'timeout'
  // 401 / 403：用户名密码错或无权限
  | 'unauthorized'
  // 404：目标路径不存在
  | 'notFound'
  // 409：父目录缺失，无法创建 / 写入
  | 'conflict'
  // 客户端校验失败：快照名 / 目录路径不安全
  | 'invalid'
  // 其他非 2xx
  | 'unexpected';

class WebDavError extends Error {
  constructor(
    readonly code: WebDavErrorCode,
    message: string,
    /** 原始 HTTP 状态码（网络层 / 校验失败时无）。 */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'WebDavError';
  }
}

// ─── 路径安全 ─────────────────────────────────────────────────────────────

/** 快照名是否安全：单段文件名（无 `/` `\` 控制符）、非 `.`/`..`、以 .zip 结尾。
 *  用于过滤 PROPFIND 列出的 href，以及上传 / 下载 / 删除前的入参校验。 */
function isSafeSnapshotName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  // eslint-disable-next-line no-control-regex
  if (/[/\\\x00-\x1f]/.test(name)) return false;
  return name.toLowerCase().endsWith('.zip');
}

/** 校验快照名安全，不安全则抛 `invalid`。防止服务端返回或调用方传入带 `..` / 编码
 *  斜杠的名字，经 URL 拼接后逃逸出目标目录。 */
function assertSafeName(name: string): void {
  if (!isSafeSnapshotName(name)) {
    throw new WebDavError('invalid', `Unsafe WebDAV snapshot name: ${JSON.stringify(name)}`);
  }
}

/** 校验远程目录路径安全。允许多级目录，但拒绝 `.`/`..`、反斜杠、控制符等会导致路径
 *  逃逸或歧义的段。 */
function assertSafeDirectory(directory: string): void {
  for (const seg of directory.split('/').filter(Boolean)) {
    // eslint-disable-next-line no-control-regex
    if (seg === '.' || seg === '..' || /[\\\x00-\x1f]/.test(seg)) {
      throw new WebDavError('invalid', `Unsafe WebDAV directory segment: ${JSON.stringify(seg)}`);
    }
  }
}

/** 校验 base URL 是「干净的」绝对 http(s) URL：必须 http/https，且不带 userinfo
 *  （`user:pass@`）/ query / hash。fetch 会把相对 URL 相对扩展页解析，配合「404 视为
 *  目录尚不存在」的成功语义，非法地址会被误判成连通，故在所有请求前强校验。拒绝
 *  userinfo / query / hash 有两层原因：① 账号密码有独立字段，混进 URL 会被原样存储并
 *  显示在连接概要里（泄露）；② `joinUrl` 在 `?` / `#` 之后拼目录会产生错误的请求目标。 */
function assertValidBaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebDavError('invalid', `Invalid WebDAV server URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebDavError('invalid', `WebDAV server URL must use http(s): ${JSON.stringify(url)}`);
  }
  if (parsed.username || parsed.password) {
    throw new WebDavError('invalid', 'WebDAV server URL must not embed credentials; use the username / password fields');
  }
  // 检测「分隔符存在」而非「值非空」：`https://x/dav?` 的 parsed.search 是空串却仍含裸
  // `?`，joinUrl 拼目录会得到 `…/dav?/cebian` 这种错误目标。用原始串里的裸 `?` / `#`
  // 判断（编码后的 %3F / %23 不算分隔符，合法）。
  if (url.includes('?') || url.includes('#')) {
    throw new WebDavError('invalid', 'WebDAV server URL must not contain a query or fragment');
  }
}

// ─── URL / 认证 ───────────────────────────────────────────────────────────

/** 把 base 与若干路径片段拼成绝对 URL：去掉 base 尾部斜杠，片段按 `/` 拆开、
 *  逐段 encodeURIComponent 后用 `/` 连接。空片段忽略。 */
function joinUrl(base: string, ...segments: string[]): string {
  const root = base.replace(/\/+$/, '');
  const path = segments
    .flatMap((s) => s.split('/'))
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return path ? `${root}/${path}` : root;
}

function dirUrl(config: WebDavConfig): string {
  assertValidBaseUrl(config.url);
  assertSafeDirectory(config.directory);
  return joinUrl(config.url, config.directory);
}

function fileUrl(config: WebDavConfig, name: string): string {
  assertValidBaseUrl(config.url);
  assertSafeDirectory(config.directory);
  assertSafeName(name);
  return joinUrl(config.url, config.directory, name);
}

/** RFC 7617 Basic 认证头，凭据按 UTF-8 字节做 base64（支持非 ASCII 用户名 / 密码）。 */
function basicAuth(config: WebDavConfig): string {
  const bytes = new TextEncoder().encode(`${config.username}:${config.password}`);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

/** 给错误信息用的脱敏 URL：只保留 origin + pathname，剥掉可能含密钥的 userinfo /
 *  query / hash，避免凭据经 toast / 日志泄露。 */
function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw.split('?')[0];
  }
}

// ─── 请求核心 ─────────────────────────────────────────────────────────────

// 请求超时（毫秒）。元数据操作（PROPFIND / MKCOL / DELETE）快，用较短超时堵住「能解析
// 但不响应」的死主机；上传 / 下载要传整个备份 zip，慢网下需要更久，用更长的超时，避免
// 切断正常的大文件传输。fetch 无内建超时，用 AbortController 实现。
const META_TIMEOUT_MS = 20_000;
const TRANSFER_TIMEOUT_MS = 5 * 60_000;

interface WebDavRequest {
  method: string;
  url: string;
  config: WebDavConfig;
  body?: BodyInit;
  headers?: Record<string, string>;
  /** 视为成功（不抛错）的额外状态码，如 PROPFIND 的 207、探测存在性时的 404。 */
  allowStatuses?: number[];
  /** 超时毫秒数，默认 META_TIMEOUT_MS；上传 / 下载传 TRANSFER_TIMEOUT_MS。 */
  timeoutMs?: number;
}

/** 发一个 WebDAV 请求；非成功状态翻译成 WebDavError 抛出。fetch 本身抛错（网络层）
 *  归为 `network`，超时（AbortController 触发）归为 `timeout`。返回原始 Response 交给
 *  调用方读 body。 */
async function request(init: WebDavRequest): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? META_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(init.url, {
      method: init.method,
      headers: { Authorization: basicAuth(init.config), ...init.headers },
      body: init.body,
      signal: controller.signal,
    });
  } catch (err) {
    // 我们的超时计时器触发的 abort：fetch 抛 AbortError，翻成 timeout。
    if (controller.signal.aborted) {
      throw new WebDavError('timeout', `WebDAV request timed out after ${timeoutMs}ms`);
    }
    throw new WebDavError(
      'network',
      `Failed to reach WebDAV server: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.ok || init.allowStatuses?.includes(res.status)) return res;
  throw mapStatus(res.status, init.method, init.url);
}

function mapStatus(status: number, method: string, url: string): WebDavError {
  const where = `${method} ${sanitizeUrl(url)} → ${status}`;
  if (status === 401 || status === 403) {
    return new WebDavError('unauthorized', `WebDAV authentication failed (${where})`, status);
  }
  if (status === 404) {
    return new WebDavError('notFound', `WebDAV path not found (${where})`, status);
  }
  if (status === 409) {
    return new WebDavError('conflict', `WebDAV parent directory missing (${where})`, status);
  }
  return new WebDavError('unexpected', `Unexpected WebDAV response (${where})`, status);
}

// ─── XML 解析（PROPFIND 多状态响应） ───────────────────────────────────────

/** 命名空间无关地取某元素下首个本地名为 `local` 的子孙节点文本。 */
function firstText(parent: Element, local: string): string | undefined {
  const el = parent.getElementsByTagNameNS('*', local)[0];
  return el?.textContent ?? undefined;
}

/** 取某元素的直接子 `<status>` 文本（用于区分 response 级与 propstat 级 status）。 */
function directChildStatusText(el: Element): string | undefined {
  for (const child of Array.from(el.children)) {
    if (child.localName === 'status') return child.textContent ?? undefined;
  }
  return undefined;
}

/** WebDAV `<status>` 形如 `HTTP/1.1 200 OK`；缺失或无法解析时按成功对待。 */
function statusOk(statusText: string | undefined): boolean {
  if (!statusText) return true;
  const m = /\b(\d{3})\b/.exec(statusText);
  if (!m) return true;
  const code = Number(m[1]);
  return code >= 200 && code < 300;
}

/** 解析 PROPFIND Depth:1 的 `multistatus` XML，抽出目录下的文件快照。XML 命名空间
 *  前缀因服务端而异（D: / d: / 无前缀），一律用本地名匹配。仅采纳 response 级与
 *  propstat 级 status 均为 2xx 的条目，并跳过集合（目录）与不安全 / 非 .zip 名字。 */
function parseSnapshotList(xml: string): WebDavSnapshot[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new WebDavError('unexpected', 'Failed to parse WebDAV PROPFIND response');
  }

  const snapshots: WebDavSnapshot[] = [];
  for (const resp of Array.from(doc.getElementsByTagNameNS('*', 'response'))) {
    // response 级 status 非 2xx：该资源整体失败，跳过。
    if (!statusOk(directChildStatusText(resp))) continue;

    const href = firstText(resp, 'href');
    if (!href) continue;
    const name = decodeHref(href);
    // 跳过目录本身（无 .zip）、非 .zip、编码斜杠等不安全名字。
    if (!isSafeSnapshotName(name)) continue;

    // 属性取自第一个 2xx 的 propstat；有 propstat 但全失败则跳过该资源。
    const propstats = Array.from(resp.getElementsByTagNameNS('*', 'propstat'));
    let scope: Element = resp;
    if (propstats.length) {
      const ok = propstats.find((ps) => statusOk(directChildStatusText(ps)));
      if (!ok) continue;
      scope = ok.getElementsByTagNameNS('*', 'prop')[0] ?? ok;
    }

    const resourceType = scope.getElementsByTagNameNS('*', 'resourcetype')[0];
    const isCollection = !!resourceType?.getElementsByTagNameNS('*', 'collection').length;
    if (isCollection) continue;

    const lengthText = firstText(scope, 'getcontentlength');
    const size = lengthText ? Number(lengthText) : undefined;
    const modifiedText = firstText(scope, 'getlastmodified');
    const parsed = modifiedText ? Date.parse(modifiedText) : NaN;

    snapshots.push({
      name,
      size: size !== undefined && Number.isFinite(size) ? size : undefined,
      lastModified: Number.isFinite(parsed) ? parsed : undefined,
    });
  }
  return snapshots;
}

/** 从 PROPFIND href 取末段文件名并解码。href 可能是完整 URL 或绝对路径，去掉查询
 *  与尾部斜杠后取最后一段。 */
function decodeHref(href: string): string {
  const noQuery = href.split('?')[0].replace(/\/+$/, '');
  const last = noQuery.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

// ─── 操作 ─────────────────────────────────────────────────────────────────

/** 测试连接：PROPFIND 远程目录。2xx/207 表示连通且鉴权通过；404 表示目录尚不存在
 *  但服务可达、鉴权通过（上传时会自动创建），亦视为成功。其余抛 WebDavError。 */
async function testConnection(config: WebDavConfig): Promise<void> {
  await request({
    method: 'PROPFIND',
    url: dirUrl(config),
    config,
    headers: { Depth: '0' },
    allowStatuses: [207, 404],
  });
}

/** 确保远程目录存在：逐级 PROPFIND，缺失的层用 MKCOL 创建（支持嵌套目录如
 *  `/cebian/backups`）。已存在则跳过。 */
async function ensureDirectory(config: WebDavConfig): Promise<void> {
  assertValidBaseUrl(config.url);
  assertSafeDirectory(config.directory);
  let acc = config.url.replace(/\/+$/, '');
  for (const seg of config.directory.split('/').filter(Boolean)) {
    acc = `${acc}/${encodeURIComponent(seg)}`;
    const probe = await request({
      method: 'PROPFIND',
      url: acc,
      config,
      headers: { Depth: '0' },
      allowStatuses: [207, 404],
    });
    if (probe.status === 404) {
      await request({ method: 'MKCOL', url: acc, config });
    }
  }
}

/** 列出远程目录下的全部 .zip 快照，按 lastModified 降序（无时间的排最后）。目录尚
 *  不存在（404）时返回空列表——调用方可平静处理「还没有快照」。 */
async function listSnapshots(config: WebDavConfig): Promise<WebDavSnapshot[]> {
  const res = await request({
    method: 'PROPFIND',
    url: dirUrl(config),
    config,
    headers: { Depth: '1' },
    allowStatuses: [207, 404],
  });
  if (res.status === 404) return [];

  const xml = await res.text();
  const snapshots = parseSnapshotList(xml);
  snapshots.sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0));
  return snapshots;
}

/** 上传一个快照：先确保目录存在，再 PUT 字节到 `<directory>/<name>`。 */
async function uploadSnapshot(
  config: WebDavConfig,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  await ensureDirectory(config);
  await request({
    method: 'PUT',
    url: fileUrl(config, name),
    config,
    headers: { 'Content-Type': 'application/zip' },
    body: bytes as BodyInit,
    timeoutMs: TRANSFER_TIMEOUT_MS,
  });
}

/** 下载一个快照的 zip 字节，供恢复。 */
async function downloadSnapshot(config: WebDavConfig, name: string): Promise<Uint8Array> {
  const res = await request({
    method: 'GET',
    url: fileUrl(config, name),
    config,
    timeoutMs: TRANSFER_TIMEOUT_MS,
  });
  return new Uint8Array(await res.arrayBuffer());
}

/** 删除一个快照。 */
async function deleteSnapshot(config: WebDavConfig, name: string): Promise<void> {
  await request({ method: 'DELETE', url: fileUrl(config, name), config });
}

// ─── 错误文案 ─────────────────────────────────────────────────────────────

// 各错误码对应的本地化文案。错误码定义在本文件，其「对用户的含义」也在此处单一维护，
// 供所有调用方（连接表单、备份区块）共用，避免在 UI 层各抄一份导致漂移。动态 key 会让
// t() 重载坍缩成 never，故按码枚举。
const ERROR_MESSAGE: Record<WebDavErrorCode, () => string> = {
  network: () => t('settings.backup.webdav.error.network'),
  timeout: () => t('settings.backup.webdav.error.timeout'),
  unauthorized: () => t('settings.backup.webdav.error.unauthorized'),
  notFound: () => t('settings.backup.webdav.error.notFound'),
  conflict: () => t('settings.backup.webdav.error.conflict'),
  invalid: () => t('settings.backup.webdav.error.invalid'),
  unexpected: () => t('settings.backup.webdav.error.unexpected'),
};

/** 把 WebDAV 操作错误翻译成可展示的本地化文案；非 WebDavError 回退到原始 message。 */
function webdavErrorMessage(err: unknown): string {
  if (err instanceof WebDavError) return ERROR_MESSAGE[err.code]();
  return err instanceof Error ? err.message : String(err);
}

// ─── 公开 API ─────────────────────────────────────────────────────────────

export {
  WebDavError,
  webdavErrorMessage,
  isSafeSnapshotName,
  assertValidBaseUrl,
  parseSnapshotList,
  testConnection,
  ensureDirectory,
  listSnapshots,
  uploadSnapshot,
  downloadSnapshot,
  deleteSnapshot,
};
export type { WebDavSnapshot, WebDavErrorCode };

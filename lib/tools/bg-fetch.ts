/**
 * `bgFetch` skill RPC handler — runs in the background service worker so it
 * inherits the extension's `<all_urls>` host_permissions and bypasses CORS.
 *
 * 跟 `fs-save-url` 的差别：fs-save-url 是 agent-facing 工具（agent 直接调、响应
 * 落 VFS）；bgFetch 是 skill-facing 能力，由 skill script 通过 sandbox 全局调用，
 * 响应 body 完整返回（不落 VFS），交给 skill 自己处置——这样 azure-image-gen 这种
 * 「调 API → 解码 → 落地 → 返回 markdown」的流程能在一个脚本里走完。
 *
 * 安全模型：
 * - 调用 URL 必须是 http(s)；其它 scheme 直接拒
 * - URL 必须命中调用方在 `metadata.permissions` 里声明的 bgFetch pattern；patterns
 *   由 sandbox-rpc 在 runInSandbox 时计算好，存进 pendingRuns 后由 handler 反查——
 *   sandbox 那侧的请求 envelope 字段全部不被信任
 * - 两层大小检查：Content-Length 预检 + 边读边累计，超 maxBytes 立刻 abort
 */

import type { MatchPattern } from './url-pattern';
import { formatMatchPattern, matchUrl } from './url-pattern';

/** Default body 上限。复用 fs-save-url 的取值，跟 SW 内存预算对齐。 */
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
/** 硬上限。超过该值的请求不允许 skill 自行抬高 —— 防 SW OOM。 */
const HARD_MAX_BYTES = 1024 * 1024 * 1024;

/** Skill 看到的 init 子集（postMessage/JSON 友好；body 二进制已经被
 *  binary envelope 还原成 Uint8Array / ArrayBuffer / string）。 */
export interface BgFetchInit {
  method?: string;
  /** Header 已被 sandbox 端 flatten 成 `Record<string,string>`（Headers 实例
   *  会先在 sandbox 那侧迭代展开）。 */
  headers?: Record<string, string>;
  body?: string | Uint8Array | ArrayBuffer;
  redirect?: 'follow' | 'error' | 'manual';
  referrer?: string;
  referrerPolicy?: ReferrerPolicy;
  cache?: RequestCache;
}

/** 跨 RPC 边界传回 sandbox 的原始响应；sandbox 一侧再包成 fetch-like 对象。 */
export interface RawBgFetchResponse {
  status: number;
  statusText: string;
  redirected: boolean;
  url: string;
  /** 扁平化的响应头；sandbox 侧 `new Headers(headersFlat)` 还原。 */
  headersFlat: Record<string, string>;
  body: Uint8Array;
}

/** Skill 不允许调用的 URL scheme —— 即使 pattern 通配也要拒。 */
function assertHttpUrl(parsed: URL): void {
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`bgFetch only supports http(s) URLs, got "${parsed.protocol}"`);
  }
}

function normalizeInit(init: unknown): RequestInit {
  if (!init || typeof init !== 'object') return {};
  const i = init as BgFetchInit;
  const out: RequestInit = {};
  if (typeof i.method === 'string') out.method = i.method;
  if (i.headers && typeof i.headers === 'object') out.headers = i.headers;
  if (i.body !== undefined) {
    // sandbox-rpc 已经走 decodeBinary 把 binary envelope 还原；这里直接透传给原生
    // fetch（fetch 自己接 string / Uint8Array / ArrayBuffer）。
    out.body = i.body as BodyInit;
  }
  if (i.redirect) out.redirect = i.redirect;
  if (typeof i.referrer === 'string') out.referrer = i.referrer;
  if (i.referrerPolicy) out.referrerPolicy = i.referrerPolicy;
  if (i.cache) out.cache = i.cache;
  return out;
}

/** 只有裸 `bgFetch`（解析为任意 HTTP(S) URL）允许浏览器自动跟随重定向。
 *  Fetch API 的 `manual` 模式只暴露 opaqueredirect，脚本拿不到 Location，无法逐跳
 *  重新做 pattern 校验；受限权限因此必须在发请求前用 `error` 禁止重定向。 */
function allowsAllHttpUrls(patterns: readonly MatchPattern[]): boolean {
  return patterns.some(p => p.scheme === '*' && p.host === '*' && p.pathGlob === '/*');
}

/**
 * 执行一次 skill 发起的 bgFetch 请求。
 *
 * `signal` 关联到 skill 整个 run 的 abort signal（由 sandbox-rpc 持有），
 * skill cancel / run 超时 / agent abort 都会触发，同时中断 fetch 握手阶段
 * 和正在进行的 body 读取。
 */
export async function handleBgFetch(
  rawUrl: unknown,
  rawInit: unknown,
  patterns: readonly MatchPattern[],
  signal?: AbortSignal,
): Promise<RawBgFetchResponse> {
  if (typeof rawUrl !== 'string') {
    throw new Error('bgFetch url must be a string');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  assertHttpUrl(parsed);

  if (!patterns.some(p => matchUrl(parsed, p))) {
    const declared = patterns.map(formatMatchPattern).join(', ');
    throw new Error(
      `URL "${parsed.href}" not allowed by bgFetch patterns. Declared: ${declared}`,
    );
  }

  // 把 skill 的 abort 桥接到内部 controller —— skill cancel 时既要中断 fetch
  // handshake，也要中断 body 流读取。
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    let resp: Response;
    try {
      const init = normalizeInit(rawInit);
      if (!allowsAllHttpUrls(patterns) && init.redirect !== 'manual') {
        init.redirect = 'error';
      }
      init.signal = controller.signal;
      resp = await fetch(parsed.href, init);
    } catch (err) {
      // AbortError 原样向上报，保留 cancellation 语义。
      if ((err as Error).name === 'AbortError' || signal?.aborted) throw err;
      throw new Error(`Network error fetching ${parsed.href}: ${(err as Error).message}`);
    }
    if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');

    // ── Content-Length 预检 ──
    const maxBytes = DEFAULT_MAX_BYTES;
    const declaredLen = parseInt(resp.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
      controller.abort();
      throw new Error(
        `Response too large: Content-Length declares ${declaredLen} bytes > maxBytes ${maxBytes}`,
      );
    }

    // ── 流式读取 + running tally ──
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = resp.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            controller.abort();
            throw new Error(
              `Response exceeded maxBytes (${maxBytes}) at ${total} bytes`,
            );
          }
          if (total > HARD_MAX_BYTES) {
            controller.abort();
            throw new Error(`Response exceeded hard cap ${HARD_MAX_BYTES} bytes`);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }

    // 合并 chunks 成单个 Uint8Array。
    const body = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      body.set(c, offset);
      offset += c.byteLength;
    }

    const headersFlat: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      headersFlat[k] = v;
    });

    return {
      status: resp.status,
      statusText: resp.statusText,
      redirected: resp.redirected,
      url: resp.url,
      headersFlat,
      body,
    };
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

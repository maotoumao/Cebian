/**
 * Chrome match-pattern parser + matcher for the `bgFetch` permission.
 *
 * 与 Chrome 自身 `host_permissions` / `chrome.cookies` 使用的同一种语法：
 *
 *   <scheme>://<host><path>
 *   <all_urls>
 *
 * 字段含义：
 * - scheme：`*` / `http` / `https`
 *   - `*` 等价 "http 或 https"（跟 Chrome 约定一致）
 *   - 其它 scheme（ws / file / ftp 等）这里拒绝 —— bgFetch 只服务 fetch
 * - host：
 *   - `*` 任意 host
 *   - `*.example.com` 该域名及任意子域（注意 Chrome 允许根 `example.com` 也命中
 *     `*.example.com`，这里沿用此约定）
 *   - `example.com` / `api.example.com` 精确匹配
 * - path：从 `/` 开始；`*` 通配任意（包括 `/`）；其它字符按字面匹配
 *
 * 不在 v1 实现：端口号、用户名密码、query/fragment 单独匹配 —— Chrome 自身
 * match-pattern 也不区分这些，path 通配已经够灵活。
 */

import { parsePermission } from './permissions';

const ALLOWED_SCHEMES = new Set(['*', 'http', 'https']);

/** 合法 host 形态：`*` / `[*.]label[.label...]`。label 允许字母数字、连字符。 */
const HOST_RE = /^(?:\*|\*\.[a-z0-9-]+(?:\.[a-z0-9-]+)*|[a-z0-9-]+(?:\.[a-z0-9-]+)*)$/i;

export interface MatchPattern {
  /** 已规范化的 scheme：`*` / `http` / `https` */
  readonly scheme: '*' | 'http' | 'https';
  /** 已规范化的 host：`*` / `*.foo.com` / `foo.com` */
  readonly host: string;
  /** 原始 path 用于错误提示 / 序列化 */
  readonly pathGlob: string;
  /** 编译好的 path 正则，匹配 `url.pathname` */
  readonly pathRe: RegExp;
  /** 仅当输入是 `<all_urls>` 时为 true —— 序列化回显用 */
  readonly isAllUrls: boolean;
}

/**
 * 解析一条 match-pattern 字符串。语法不合法时抛错（错误消息明确指出哪一段问题），
 * 让 `runInSandbox` 在启动时就把坏 pattern 拦下而不是延迟到 skill 第一次调用。
 */
export function parseMatchPattern(input: string): MatchPattern {
  if (input === '<all_urls>') {
    return {
      scheme: '*',
      host: '*',
      pathGlob: '/*',
      pathRe: /^\/.*$/,
      isAllUrls: true,
    };
  }

  const m = input.match(/^([^:]+):\/\/([^/]+)(\/.*)$/);
  if (!m) {
    throw new Error(
      `malformed pattern (expected "<scheme>://<host>/<path>" or "<all_urls>"): ${input}`,
    );
  }
  const [, schemeRaw, hostRaw, pathRaw] = m;
  const scheme = schemeRaw.toLowerCase();
  if (!ALLOWED_SCHEMES.has(scheme)) {
    throw new Error(
      `unsupported scheme "${schemeRaw}" in pattern "${input}" — only *, http, https are allowed`,
    );
  }
  const host = hostRaw.toLowerCase();
  if (!HOST_RE.test(host)) {
    throw new Error(`invalid host "${hostRaw}" in pattern "${input}"`);
  }
  if (!pathRaw.startsWith('/')) {
    // 兜底：上面正则已经保证 pathRaw 以 `/` 开头，这条主要给未来重构留警示。
    throw new Error(`invalid path "${pathRaw}" in pattern "${input}" — must start with "/"`);
  }

  // 编译 path glob → 正则：先把正则元字符 escape，再把字面 `*` 替换成 `.*`。
  const escaped = pathRaw.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const pathReStr = '^' + escaped.replace(/\*/g, '.*') + '$';

  return {
    scheme: scheme as '*' | 'http' | 'https',
    host,
    pathGlob: pathRaw,
    pathRe: new RegExp(pathReStr),
    isAllUrls: false,
  };
}

/** 把 pattern 序列化回字符串（错误信息里列出已声明 pattern 时用）。 */
export function formatMatchPattern(p: MatchPattern): string {
  if (p.isAllUrls) return '<all_urls>';
  return `${p.scheme}://${p.host}${p.pathGlob}`;
}

/**
 * 判断 url 是否匹配 pattern。url 必须已经是合法的 `URL` 实例。
 * scheme `*` 仅匹配 http/https（不通配其它 scheme）—— 与 Chrome 约定一致。
 */
export function matchUrl(url: URL, pattern: MatchPattern): boolean {
  // ── scheme ──
  // url.protocol 形如 'https:'，去掉尾随冒号
  const urlScheme = url.protocol.slice(0, -1).toLowerCase();
  if (pattern.scheme === '*') {
    if (urlScheme !== 'http' && urlScheme !== 'https') return false;
  } else if (pattern.scheme !== urlScheme) {
    return false;
  }

  // ── host ──
  if (pattern.host !== '*') {
    if (pattern.host.startsWith('*.')) {
      const suffix = pattern.host.slice(2);
      // Chrome 约定：`*.foo.com` 匹配 `foo.com` 和任意 `*.foo.com`。
      if (url.hostname !== suffix && !url.hostname.endsWith('.' + suffix)) {
        return false;
      }
    } else if (url.hostname !== pattern.host) {
      return false;
    }
  }

  // ── path（不含 query / fragment）──
  if (!pattern.pathRe.test(url.pathname)) return false;
  return true;
}

/**
 * 从 `metadata.permissions` 抽出 bgFetch 相关项，逐条解析成 MatchPattern。
 *
 * - `bgFetch`（裸）等价于 `*://*\/*`，覆盖任意 http(s) URL
 * - `bgFetch:<pattern>` 按 match-pattern 解析
 *
 * 返回 null 表示没有声明任何 bgFetch 权限。任何 pattern 解析失败 → 抛错，
 * 错误消息里包含原始权限字符串，便于 skill 作者定位。
 */
export function parseBgFetchPatterns(permissions: readonly string[]): MatchPattern[] | null {
  const patterns: MatchPattern[] = [];
  for (const p of permissions) {
    // 认 token 统一走沙箱能力词汇（lib/tools/permissions），不在这里重复比字符串。
    const perm = parsePermission(p);
    if (perm?.kind !== 'bgFetch') continue;
    // 裸 bgFetch（pattern 缺省）等价 `*://*\/*`，覆盖任意 http(s) URL。
    const patternStr = perm.pattern ?? '*://*/*';
    try {
      patterns.push(parseMatchPattern(patternStr));
    } catch (err) {
      throw new Error(`Invalid bgFetch permission "${p}": ${(err as Error).message}`);
    }
  }
  return patterns.length === 0 ? null : patterns;
}

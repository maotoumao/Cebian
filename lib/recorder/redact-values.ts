// 网络录制打码的基础改写规则：URL、参数、字符串值、JSON。判断规则（敏感名字、凭据迹象）在
// `secret-hints.ts`；头部与各种正文格式的处理在 `redact.ts`，它组合这里的规则。
//
// 已知盲区：URL 路径里不带名字的令牌（`/reset-password/<token>`、Slack / Telegram 等把密钥
// 放在路径里的 webhook）无法与普通路径区分，原样保留；路径只检查敏感名字的赋值与内嵌结构。

import {
  REDACTED_WORD,
  hasNameHints,
  hasSecretHints,
  hasStructuralHints,
  hasUrlUserinfo,
  isSensitiveName,
  isSensitiveEncodedName,
  hasCredentialHintWord,
  looksLikeJson,
  looksLikeUrl,
} from './secret-hints';

const REDACTED = `[${REDACTED_WORD}]`;

/** JSON 与 URL 嵌套递归的共同深度上限：更深的部分整体打码（防止耗尽调用栈）。 */
const MAX_DEPTH = 64;

/** JSON 防劫持前缀（Google 等站点在 JSON 前加的不可执行片段）。 */
const ANTI_HIJACK_PREFIX = /^\s*(?:\)\]\}'|while\s*\(1\);|for\s*\(;;\);)\s*/;

interface Redacted<T> {
  value: T;
  changed: boolean;
}

// ─── JSON 解析（保住大整数的原始写法） ───

interface RawJsonApi {
  rawJSON(text: string): unknown;
  isRawJSON(value: unknown): boolean;
}

const rawJson = JSON as unknown as Partial<RawJsonApi>;
const supportsRawJson = typeof rawJson.rawJSON === 'function' && typeof rawJson.isRawJSON === 'function';

/** 数字保持原始写法（`JSON.rawJSON`），重新序列化时大整数不丢精度。 */
function parseJson(text: string): unknown {
  if (!supportsRawJson) return JSON.parse(text);
  return JSON.parse(text, function reviver(this: unknown, _key: string, value: unknown, context?: { source?: string }) {
    return typeof value === 'number' && context?.source != null ? rawJson.rawJSON!(context.source) : value;
  } as (key: string, value: unknown) => unknown);
}

function isRawJsonValue(value: unknown): boolean {
  return supportsRawJson && rawJson.isRawJSON!(value);
}

// ─── URL 与参数 ───

/** 参数串打码，保持原有顺序；参数值按字符串值规则处理（内嵌 JSON、URL、凭据迹象）。 */
function redactParams(query: string, depth: number): Redacted<string> {
  const params = new URLSearchParams(query);
  let changed = false;
  const entries = [...params].map(([name, value]): [string, string] => {
    if (hasNameHints(name)) {
      changed = true;
      return [REDACTED, REDACTED];
    }
    if (isSensitiveEncodedName(name)) {
      changed = true;
      return [name, REDACTED];
    }
    const nested = redactStringValue(value, depth + 1);
    changed ||= nested.changed;
    return [name, nested.value];
  });
  return changed ? { value: new URLSearchParams(entries).toString(), changed } : { value: query, changed };
}

/** 路径里的矩阵参数（`;jsessionid=…`）。 */
const MATRIX_PARAM = /;([^;/=]*)=([^;/]*)/g;

/** 路径：矩阵参数按名打码（名字本身装着凭据时连名字一起换掉）；其余部分还有凭据迹象就把整段路径换成占位。 */
function redactPath(path: string): Redacted<string> {
  let changed = false;
  const value = path.replace(MATRIX_PARAM, (whole, name: string) => {
    if (hasNameHints(name)) {
      changed = true;
      return `;${REDACTED_WORD}=${REDACTED_WORD}`;
    }
    if (!isSensitiveEncodedName(name)) return whole;
    changed = true;
    return `;${name}=${REDACTED_WORD}`;
  });
  const rest = path.replace(MATRIX_PARAM, (whole, name: string) =>
    (hasNameHints(name) || isSensitiveEncodedName(name) ? ';' : whole));
  if (hasStructuralHints(rest)) return { value: path.startsWith('/') ? `/${REDACTED_WORD}` : REDACTED_WORD, changed: true };
  return { value, changed };
}

/** 片段：SPA 的路由（`#/cb?code=…`）拆成路径与参数分别处理；OAuth 隐式流程的 `k=v` 按参数处理。 */
function redactFragment(fragment: string, depth: number): Redacted<string> {
  const q = fragment.indexOf('?');
  if (q < 0 && fragment.includes('=') && !fragment.startsWith('/')) return redactParams(fragment, depth);
  const route = redactPath(q < 0 ? fragment : fragment.slice(0, q));
  const params = q < 0 ? undefined : redactParams(fragment.slice(q + 1), depth);
  if (!route.changed && !params?.changed) return { value: fragment, changed: false };
  return { value: params ? `${route.value}?${params.value}` : route.value, changed: true };
}

/**
 * URL 打码：用户名 / 密码、路径里的敏感赋值、查询参数、片段（路由参数与 OAuth 隐式流程
 * 的令牌）。只替换这几段子串，协议、主机、相对路径等其余部分原样保留。处理完仍能看出带
 * 用户信息（浏览器能解析出用户信息的变体写法）就整个打码。
 */
function redactUrlString(url: string, depth: number): Redacted<string> {
  if (depth > MAX_DEPTH) return { value: REDACTED, changed: true };
  let changed = false;

  const hashIndex = url.indexOf('#');
  let fragment = hashIndex >= 0 ? url.slice(hashIndex + 1) : undefined;
  const beforeHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = beforeHash.indexOf('?');
  let query = queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : undefined;
  const base = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;

  // 用户信息：scheme://user:pass@host、//user@host；以 authority 里最后一个 @ 为界
  let origin = '';
  let path = base;
  const authority = /^(\s*(?:[a-z][a-z0-9+.-]*:)?\/\/)([^/]*)/i.exec(base);
  if (authority) {
    let host = authority[2];
    const at = host.lastIndexOf('@');
    if (at >= 0) {
      host = `${REDACTED_WORD}@${host.slice(at + 1)}`;
      changed = true;
    }
    origin = authority[1] + host;
    path = base.slice(authority[0].length);
  }

  const redactedPath = redactPath(path);
  if (redactedPath.changed) {
    path = redactedPath.value;
    changed = true;
  }
  if (query) {
    const r = redactParams(query, depth);
    if (r.changed) {
      query = r.value;
      changed = true;
    }
  }
  if (fragment) {
    const r = redactFragment(fragment, depth);
    if (r.changed) {
      fragment = r.value;
      changed = true;
    }
  }
  const withQuery = query != null ? `${origin}${path}?${query}` : `${origin}${path}`;
  const value = fragment != null ? `${withQuery}#${fragment}` : withQuery;
  if (hasUrlUserinfo(value)) return { value: REDACTED, changed: true };
  return changed ? { value, changed } : { value: url, changed: false };
}

/** 出错时的兜底：去掉用户信息与路径之后的全部内容。 */
function stripUrl(url: string): string {
  const authority = /^\s*(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*/i.exec(url)?.[0];
  return authority ? `${authority.replace(/\/\/[^/?#]*@/, `//${REDACTED_WORD}@`)}/${REDACTED_WORD}` : REDACTED;
}

/** URL 的用户信息、路径里的敏感赋值、查询参数与片段按名打码；相对地址、无法解析的地址同样处理。 */
function redactUrl(url: string): string {
  try {
    return redactUrlString(url, 0).value;
  } catch {
    return stripUrl(url);
  }
}

/**
 * 字符串值：整段是 URL（允许首尾空白）或 JSON 时递归打码；其余文本有凭据迹象就整段打码。
 * 内嵌的 JSON 总是重新序列化：重复的键在解析时只留最后一个，原文里前面那些没检查过。
 */
function redactStringValue(text: string, depth: number): Redacted<string> {
  if (depth > MAX_DEPTH) return { value: REDACTED, changed: true };
  const trimmed = text.trim();
  if (trimmed && looksLikeUrl(trimmed)) {
    const r = redactUrlString(trimmed, depth);
    if (!r.changed) return { value: text, changed: false };
    const start = text.indexOf(trimmed);
    return { value: text.slice(0, start) + r.value + text.slice(start + trimmed.length), changed: true };
  }
  if (looksLikeJson(trimmed)) {
    let parsed: unknown;
    let ok = true;
    try {
      parsed = parseJson(text);
    } catch {
      ok = false;
    }
    if (ok) {
      const value = JSON.stringify(redactJsonValue(parsed, depth + 1).value);
      return { value, changed: value !== text };
    }
  }
  return hasSecretHints(text) ? { value: REDACTED, changed: true } : { value: text, changed: false };
}

// ─── JSON ───

/** `{ name: "password", value: "…" }` 这类名值对列表里装值的字段。 */
const PAIR_NAME_KEYS: ReadonlySet<string> = new Set(['name', 'key', 'keyname', 'field', 'header', 'param', 'type', 'label']);
const PAIR_VALUE_KEYS: ReadonlySet<string> = new Set(['value', 'val', 'values', 'content', 'data']);

/**
 * 只在参数里才算敏感的名字（`code` / `ticket` / `sign`）出现在 JSON 里时，值像授权码才打码：
 * 无空白、至少 16 个字符且字母数字混合（Google `4/0A…`、Microsoft `0.AXk…`、CAS `ST-…`），
 * 或 4–8 位数字串（短信验证码）。`"code": "E1001"`、数值状态码 `200` 不受影响。
 */
const TOKEN_LIKE_VALUE = /^(?=[^A-Za-z]*[A-Za-z])(?=[^0-9]*[0-9])\S{16,}$/;
const NUMERIC_CODE_VALUE = /^\d{4,8}$/;
/**
 * 名字带 `token` / `key` / `encoded` 等提示单词时（`tokenValue`、`sharedKey`、`primaryKey`、
 * Elasticsearch 的 `encoded`），值像密钥就打码：无空白、至少 16 个字符（base32 的 TOTP 种子可以
 * 全是字母）。看起来是 URL、带文件扩展名的路径（`uploads/a1b2.jpg`）不算；`"key": "Enter"`、
 * `"token_type": "Bearer"` 这类短值不受影响。
 */
const SECRET_LIKE_VALUE = /^\S{16,}$/;
const FILE_PATH_VALUE = /\.[A-Za-z0-9]{1,5}$/;
/** 标准 base64（带补齐、长度是 4 的倍数）：可能以 `/` 开头，不能因此当成路径放过。 */
const BASE64_VALUE = /^[A-Za-z0-9+/]{22,}={0,2}$/;

function looksLikeSecret(value: unknown): boolean {
  if (typeof value !== 'string' || !SECRET_LIKE_VALUE.test(value)) return false;
  if (BASE64_VALUE.test(value) && value.length % 4 === 0) return true;
  return !looksLikeUrl(value) && !FILE_PATH_VALUE.test(value);
}

/**
 * JWK（RFC 7517 / 7518，带 `kty` 的对象）里的私密成员：对称密钥 `k`，RSA / EC 私钥的
 * `d` `p` `q` `dp` `dq` `qi` `oth`。公钥成员（`n` `e` `x` `y`）保留。
 */
const JWK_PRIVATE_MEMBERS: ReadonlySet<string> = new Set(['k', 'd', 'p', 'q', 'dp', 'dq', 'qi', 'oth']);

/** JSON 里名字本身不算敏感、但值的形态像凭据（见上面两组规则）；数组按其中的字符串判断。 */
function looksLikeCredentialValue(key: string, value: unknown): boolean {
  // 带提示单词的名字只按密钥形态判断；`key` 同时是参数语境的敏感名，在 JSON 里也归这条
  if (hasCredentialHintWord(key)) {
    return Array.isArray(value) ? value.some(looksLikeSecret) : looksLikeSecret(value);
  }
  if (typeof value !== 'string') return false;
  const paramOnly = isSensitiveName(key, 'param') && !isSensitiveName(key, 'field');
  return paramOnly && (TOKEN_LIKE_VALUE.test(value) || NUMERIC_CODE_VALUE.test(value));
}

/**
 * 字段名：装着 URL 时按 URL 打码；有凭据迹象（含编码后才看得出的敏感名字）时整个换成占位，
 * 并标记 `hinted`，对应的值也一并打码。
 */
function redactKey(key: string, depth: number): { value: string; hinted: boolean } {
  const trimmed = key.trim();
  if (trimmed && looksLikeUrl(trimmed)) return { value: redactUrlString(key, depth).value, hinted: false };
  // 解码后才看得出敏感（`pass%77ord`）：原名不会触发按名打码，这里连值一起处理
  const encodedOnly = (['param', 'field'] as const).some((context) =>
    isSensitiveEncodedName(key, context) && !isSensitiveName(key, context));
  return hasNameHints(key) || encodedOnly
    ? { value: REDACTED, hinted: true }
    : { value: key, hinted: false };
}

function redactJsonValue(value: unknown, depth: number): Redacted<unknown> {
  if (depth > MAX_DEPTH) return { value: REDACTED, changed: true };
  if (typeof value === 'string') return redactStringValue(value, depth);
  if (isRawJsonValue(value)) return { value, changed: false };
  if (Array.isArray(value)) {
    // `["Authorization", "Bearer …"]`、`["otp", 123456]` 这类名值对：第二项不论类型整体打码
    const pairName = value.length === 2 && typeof value[0] === 'string' && isSensitiveEncodedName(value[0]);
    let changed = false;
    const out = value.map((child, i) => {
      if (pairName && i === 1) {
        changed = true;
        return REDACTED;
      }
      const r = redactJsonValue(child, depth + 1);
      changed ||= r.changed;
      return r.value;
    });
    return { value: out, changed };
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    const isJwk = entries.some(([key, child]) => key === 'kty' && typeof child === 'string');
    const pairName = entries.some(([key, child]) =>
      PAIR_NAME_KEYS.has(key.toLowerCase()) && typeof child === 'string' && isSensitiveEncodedName(child));
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, child] of entries) {
      const safeKey = redactKey(key, depth + 1);
      changed ||= safeKey.value !== key;
      let next: unknown;
      if (
        safeKey.hinted
        || isSensitiveName(key, 'field')
        || (pairName && PAIR_VALUE_KEYS.has(key.toLowerCase()))
        || looksLikeCredentialValue(key, child)
        || (isJwk && JWK_PRIVATE_MEMBERS.has(key))
      ) {
        next = REDACTED;
        changed = true;
      } else {
        const r = redactJsonValue(child, depth + 1);
        next = r.value;
        changed ||= r.changed;
      }
      // 用 defineProperty 写入：普通赋值遇到 `__proto__` 键会改原型而不是写字段
      Object.defineProperty(out, safeKey.value, { value: next, enumerable: true, writable: true, configurable: true });
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

/**
 * JSON 文本打码（可带防劫持前缀），解析不了返回 undefined。总是重新序列化（紧凑格式）：
 * 重复的键在解析时只留最后一个，原文里前面那些没检查过，不能原样返回。
 */
function redactJsonText(text: string): string | undefined {
  const prefix = ANTI_HIJACK_PREFIX.exec(text)?.[0] ?? '';
  let parsed: unknown;
  try {
    parsed = parseJson(text.slice(prefix.length));
  } catch {
    return undefined;
  }
  return prefix + JSON.stringify(redactJsonValue(parsed, 0).value);
}

// ─── 公开 API ───

export {
  ANTI_HIJACK_PREFIX,
  REDACTED,
  redactJsonText,
  redactParams,
  redactStringValue,
  redactUrl,
};

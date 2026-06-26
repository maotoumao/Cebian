/**
 * Sandbox execution engine.
 * Runs skill scripts with dynamic code evaluation (allowed by sandbox CSP).
 * Chrome API calls are proxied back to the background via postMessage → offscreen → background.
 */

import { encodeBinary, encodeBinaryArgs, decodeBinary } from '@/lib/ipc/sandbox-binary';
import { parsePermission } from '@/lib/tools/permissions';

// ─── Message types (shared with sandbox-rpc.ts) ───

interface RunRequest {
  type: 'sandbox:run';
  id: string;
  code: string;
  args: Record<string, unknown>;
  permissions: string[];
  /** 由 sandbox-rpc 受信注入：该 run 的 vfs 作用域绝对路径，仅用于
   *  暴露 `vfs.cwd` 给 skill 脚本。真正的路径校验仍在 background 一侧，
   *  sandbox 把该值伪造也不会影响后端权威解析。null = 未声明 vfs 权限。 */
  vfsRoot: string | null;
  tabId?: number;
}

interface RunResponse {
  type: 'sandbox:run_result';
  id: string;
  result?: unknown;
  error?: string;
}

interface ChromeApiCall {
  type: 'sandbox:chrome_call';
  id: string;
  callId: string;
  namespace: string;
  method: string;
  args: unknown[];
}

interface ChromeApiResponse {
  type: 'sandbox:chrome_result';
  id: string;
  callId: string;
  result?: unknown;
  error?: string;
}

interface PageExecCall {
  type: 'sandbox:page_exec';
  id: string;
  callId: string;
  code: string;
  tabId?: number;
}

interface PageExecResponse {
  type: 'sandbox:page_exec_result';
  id: string;
  callId: string;
  result?: string;
  error?: string;
}

interface VfsCall {
  type: 'sandbox:vfs_call';
  id: string;
  callId: string;
  method: string;
  args: unknown[];
}

interface VfsResponse {
  type: 'sandbox:vfs_result';
  id: string;
  callId: string;
  result?: unknown;
  error?: string;
}

interface BgFetchCall {
  type: 'sandbox:bg_fetch';
  id: string;
  callId: string;
  url: string;
  init: unknown;
}

interface RawBgFetchResponseFromBg {
  status: number;
  statusText: string;
  redirected: boolean;
  url: string;
  headersFlat: Record<string, string>;
  /** binary envelope —— sandbox dispatcher 接收时会先 decodeBinary 还原成 Uint8Array */
  body: unknown;
}

interface BgFetchResponseMsg {
  type: 'sandbox:bg_fetch_result';
  id: string;
  callId: string;
  result?: RawBgFetchResponseFromBg;
  error?: string;
}

// ─── Pending async calls waiting for response from background ───

const pendingCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

// ─── Chrome API Proxy ───

function createChromeProxy(permissions: string[], requestId: string): Record<string, unknown> {
  // 认 token 统一走沙箱能力词汇（lib/tools/permissions），不在这里重复比字符串。
  const allowedNamespaces = new Set<string>();
  for (const p of permissions) {
    const perm = parsePermission(p);
    if (perm?.kind === 'chrome') allowedNamespaces.add(perm.namespace);
  }
  if (allowedNamespaces.size === 0) return {};

  return new Proxy({} as Record<string, unknown>, {
    get(_target, ns: string) {
      if (typeof ns !== 'string' || !allowedNamespaces.has(ns)) return undefined;
      return new Proxy({}, {
        get(_t, method: string) {
          if (typeof method !== 'string') return undefined;
          return (...args: unknown[]) => {
            const callId = crypto.randomUUID();
            return new Promise((resolve, reject) => {
              pendingCalls.set(callId, { resolve, reject });
              window.parent.postMessage({
                type: 'sandbox:chrome_call',
                id: requestId,
                callId,
                namespace: ns,
                method,
                args,
              } satisfies ChromeApiCall, '*');
            });
          };
        },
      });
    },
  });
}

// ─── executeInPage proxy ───

function createPageExec(requestId: string, tabId?: number): (code: string) => Promise<string> {
  return (code: string) => {
    const callId = crypto.randomUUID();
    return new Promise<string>((resolve, reject) => {
      pendingCalls.set(callId, {
        resolve: (v) => resolve(v as string),
        reject,
      });
      window.parent.postMessage({
        type: 'sandbox:page_exec',
        id: requestId,
        callId,
        code,
        tabId,
      } satisfies PageExecCall, '*');
    });
  };
}

// ─── VFS proxy ───
// skill 看到的 `vfs` 全局：方法名跟 lib/vfs.ts 子集对齐，所有路径**相对** skill
// 自己的 workspace 目录（`/workspaces/<sessionId>/<skill>`）。真正的路径解析 +
// 权限校验在 background sandbox-rpc.ts 这边完成 —— sandbox 只负责打包消息、
// 等结果。
//
// 仅在声明了 vfs.read / vfs.write 至少其一时，才向 globals 暴露 `vfs`。
//
// 额外暴露只读属性 `vfs.cwd`：该 skill 在 VFS 里的绝对根路径。便于 skill
// 写完文件后构造 markdown 链接，例如：
//   await vfs.writeFile('cat.png', bytes);
//   module.exports = `![cat](#${vfs.cwd}/cat.png)`;

const VFS_METHOD_NAMES = new Set([
  'readFile', 'writeFile', 'mkdir', 'readdir', 'stat', 'exists', 'unlink',
]);

function createVfsProxy(
  permissions: string[],
  vfsRoot: string | null,
  requestId: string,
): Record<string, unknown> | undefined {
  const hasRead = permissions.some(p => parsePermission(p)?.kind === 'vfsRead');
  const hasWrite = permissions.some(p => parsePermission(p)?.kind === 'vfsWrite');
  if (!hasRead && !hasWrite) return undefined;
  // sandbox-rpc 一侧保证：声明了任一 vfs 权限 → vfsRoot 必有值。
  // 走到这里还是 null 说明上游 wiring 坏了，与其静默返回 undefined
  // 让 skill 拿到含糊的 "vfs is undefined"，不如在 sandbox 启动时直接报错。
  if (!vfsRoot) {
    throw new Error('internal: vfs permission declared but vfsRoot missing (sandbox-rpc bug)');
  }

  return new Proxy({} as Record<string, unknown>, {
    get(_t, key: string) {
      if (typeof key !== 'string') return undefined;
      if (key === 'cwd') return vfsRoot;
      if (!VFS_METHOD_NAMES.has(key)) return undefined;
      return (...callArgs: unknown[]) => {
        const callId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
          pendingCalls.set(callId, { resolve, reject });
          window.parent.postMessage({
            type: 'sandbox:vfs_call',
            id: requestId,
            callId,
            method: key,
            // 跨 offscreen → background 这一跳是 chrome.runtime.sendMessage（JSON-only），
            // 任何 Uint8Array / ArrayBuffer 会被压成普通对象。`encodeBinaryArgs` 在边界
            // 处把它们包成 base64 信封，handler 一侧 `decodeBinaryArgs` 还原。
            args: encodeBinaryArgs(callArgs),
          } satisfies VfsCall, '*');
        });
      };
    },
  });
}

// ─── bgFetch (background fetch) proxy ───
// 让 skill 通过 background SW 发请求，绕开 sandbox iframe 的 opaque origin
// 与 CORS 限制。接口形状跟原生 `fetch` 尽量贴合：返回值是带 `text()` /
// `json()` / `arrayBuffer()` / `bytes()` / `blob()` 方法、`Headers` 实例的
// fetch-like Response。
//
// 仅在声明了任一 `bgFetch` / `bgFetch:<pattern>` 权限时暴露；URL 是否命中
// pattern 由 background 一侧权威校验，sandbox 无法绕过。

/** Sandbox 拿到 skill 写的 `init`，按 fetch RequestInit 子集 normalize 后发出去。
 *  - headers: Headers 实例 → 迭代 flatten 成 Record<string,string>；plain object 透传
 *  - body: Uint8Array / ArrayBuffer 走 encodeBinary 进 base64 envelope；string 透传
 *    其它二进制视图（Int8Array / DataView 等）也由 encodeBinary 兜底处理 */
function normalizeBgFetchInit(init: unknown): unknown {
  if (!init || typeof init !== 'object') return undefined;
  const i = init as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof i.method === 'string') out.method = i.method;
  if (i.headers !== undefined) {
    if (typeof Headers !== 'undefined' && i.headers instanceof Headers) {
      const flat: Record<string, string> = {};
      i.headers.forEach((v, k) => { flat[k] = v; });
      out.headers = flat;
    } else if (typeof i.headers === 'object') {
      out.headers = i.headers;
    }
  }
  if (i.body !== undefined) out.body = encodeBinary(i.body);
  if (i.redirect) out.redirect = i.redirect;
  if (typeof i.referrer === 'string') out.referrer = i.referrer;
  if (i.referrerPolicy) out.referrerPolicy = i.referrerPolicy;
  if (i.cache) out.cache = i.cache;
  return out;
}

/** Skill 看到的 fetch-like Response。`body` 已经在边界处还原成 Uint8Array，
 *  reader 方法都是 sync-delivered Promise；不实现 `bodyUsed` consume-once
 *  语义 —— 数据已 buffered，多次 `text()` / `json()` 没风险。 */
interface BgFetchResponseShape {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly redirected: boolean;
  readonly url: string;
  readonly headers: Headers;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  blob(): Promise<Blob>;
}

function buildBgFetchResponse(raw: RawBgFetchResponseFromBg): BgFetchResponseShape {
  // body 已经在 dispatcher 那里 decodeBinary 还原成 Uint8Array。
  const bytes = raw.body as Uint8Array;
  const headers = new Headers(raw.headersFlat);
  const contentType = headers.get('content-type') ?? '';
  return {
    status: raw.status,
    statusText: raw.statusText,
    ok: raw.status >= 200 && raw.status < 300,
    redirected: raw.redirected,
    url: raw.url,
    headers,
    async text() { return new TextDecoder().decode(bytes); },
    async json() { return JSON.parse(new TextDecoder().decode(bytes)); },
    async arrayBuffer() {
      // 返回独立的 ArrayBuffer 拷贝，避免 skill 拿到的 buffer 跟内部 Uint8Array
      // 共享底层、修改其一污染另一处。
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      return ab;
    },
    async bytes() { return bytes; },
    async blob() {
      // `Uint8Array<ArrayBufferLike>` 在严格 TS 配置下不直接满足 `BlobPart`
      // （会包含 SharedArrayBuffer），加一道 cast。运行期没问题 —— 这里只可能
      // 是 ArrayBuffer-backed Uint8Array。
      return new Blob([bytes as BlobPart], { type: contentType });
    },
  };
}

function createBgFetch(
  permissions: string[],
  requestId: string,
): ((url: string, init?: unknown) => Promise<BgFetchResponseShape>) | undefined {
  const hasBgFetch = permissions.some(p => parsePermission(p)?.kind === 'bgFetch');
  if (!hasBgFetch) return undefined;

  return (url: string, init?: unknown): Promise<BgFetchResponseShape> => {
    const callId = crypto.randomUUID();
    return new Promise<BgFetchResponseShape>((resolve, reject) => {
      pendingCalls.set(callId, {
        resolve: (raw) => resolve(buildBgFetchResponse(raw as RawBgFetchResponseFromBg)),
        reject,
      });
      window.parent.postMessage({
        type: 'sandbox:bg_fetch',
        id: requestId,
        callId,
        url,
        init: normalizeBgFetchInit(init),
      } satisfies BgFetchCall, '*');
    });
  };
}

// ─── Script Execution ───

async function executeScript(req: RunRequest): Promise<unknown> {
  const { code, args, permissions, tabId, vfsRoot } = req;

  // Build sandbox globals
  const globals: Record<string, unknown> = {
    fetch: fetch.bind(globalThis),
    JSON,
    console,
    crypto,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    AbortController,
    args,
  };

  // Chrome API proxy (only declared namespaces)
  const chromeProxy = createChromeProxy(permissions, req.id);
  if (Object.keys(chromeProxy).length > 0 || permissions.some(p => parsePermission(p)?.kind === 'chrome')) {
    globals.chrome = chromeProxy;
  }

  // executeInPage function (if page.executeJs permission declared)
  if (permissions.some(p => parsePermission(p)?.kind === 'pageExecuteJs')) {
    globals.executeInPage = createPageExec(req.id, tabId);
  }

  // vfs proxy (if vfs.read or vfs.write permission declared)
  const vfsProxy = createVfsProxy(permissions, vfsRoot, req.id);
  if (vfsProxy) {
    globals.vfs = vfsProxy;
  }

  // bgFetch (if any bgFetch / bgFetch:<pattern> permission declared)
  const bgFetch = createBgFetch(permissions, req.id);
  if (bgFetch) {
    globals.bgFetch = bgFetch;
  }

  // Build and execute using new Function (allowed in sandbox CSP)
  const keys = Object.keys(globals);
  const values = keys.map(k => globals[k]);

  // Support module.exports style: script sets module.exports = value
  const moduleObj = { exports: undefined as unknown };
  keys.push('module');
  values.push(moduleObj);

  const wrappedCode = `return (async () => {\n${code}\n})()`;
  const fn = new Function(...keys, wrappedCode);
  await fn(...values);

  return moduleObj.exports;
}

// ─── Message Handler ───

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'sandbox:run': {
      const req = msg as RunRequest;
      try {
        const result = await executeScript(req);
        let serialized: unknown;
        try {
          serialized = result !== undefined ? JSON.parse(JSON.stringify(result)) : undefined;
        } catch {
          serialized = String(result);
        }
        window.parent.postMessage({
          type: 'sandbox:run_result',
          id: req.id,
          result: serialized,
        } satisfies RunResponse, '*');
      } catch (err) {
        window.parent.postMessage({
          type: 'sandbox:run_result',
          id: req.id,
          error: (err as Error).message,
        } satisfies RunResponse, '*');
      }
      break;
    }

    case 'sandbox:chrome_result': {
      const resp = msg as ChromeApiResponse;
      const pending = pendingCalls.get(resp.callId);
      if (pending) {
        pendingCalls.delete(resp.callId);
        if (resp.error) {
          pending.reject(new Error(resp.error));
        } else {
          pending.resolve(resp.result);
        }
      }
      break;
    }

    case 'sandbox:page_exec_result': {
      const resp = msg as PageExecResponse;
      const pending = pendingCalls.get(resp.callId);
      if (pending) {
        pendingCalls.delete(resp.callId);
        if (resp.error) {
          pending.reject(new Error(resp.error));
        } else {
          pending.resolve(resp.result);
        }
      }
      break;
    }

    case 'sandbox:vfs_result': {
      const resp = msg as VfsResponse;
      const pending = pendingCalls.get(resp.callId);
      if (pending) {
        pendingCalls.delete(resp.callId);
        if (resp.error) {
          pending.reject(new Error(resp.error));
        } else {
          // readFile 的二进制返回也是从 background 经 JSON 通道过来，
          // 这里反向解包还原成 Uint8Array。
          pending.resolve(decodeBinary(resp.result));
        }
      }
      break;
    }

    case 'sandbox:bg_fetch_result': {
      const resp = msg as BgFetchResponseMsg;
      const pending = pendingCalls.get(resp.callId);
      if (pending) {
        pendingCalls.delete(resp.callId);
        if (resp.error) {
          pending.reject(new Error(resp.error));
        } else if (resp.result) {
          // body 是 binary envelope，先解包再原样交给 createBgFetch 的 resolve
          // 包装成 fetch-like Response。
          const raw = resp.result;
          const decoded: RawBgFetchResponseFromBg = {
            status: raw.status,
            statusText: raw.statusText,
            redirected: raw.redirected,
            url: raw.url,
            headersFlat: raw.headersFlat,
            body: decodeBinary(raw.body),
          };
          pending.resolve(decoded);
        } else {
          pending.reject(new Error('bg_fetch_result missing both result and error'));
        }
      }
      break;
    }
  }
});

// Signal ready to parent
window.parent.postMessage({ type: 'sandbox:ready' }, '*');

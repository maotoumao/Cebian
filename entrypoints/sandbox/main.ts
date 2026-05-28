/**
 * Sandbox execution engine.
 * Runs skill scripts with dynamic code evaluation (allowed by sandbox CSP).
 * Chrome API calls are proxied back to the background via postMessage → offscreen → background.
 */

import { encodeBinaryArgs, decodeBinary } from '@/lib/sandbox-binary';

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

// ─── Pending async calls waiting for response from background ───

const pendingCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

// ─── Chrome API Proxy ───

function createChromeProxy(permissions: string[], requestId: string): Record<string, unknown> {
  const chromePerms = permissions.filter(p => p.startsWith('chrome.'));
  if (chromePerms.length === 0) return {};

  const allowedNamespaces = new Set(chromePerms.map(p => p.replace(/^chrome\./, '')));

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
  const hasRead = permissions.includes('vfs.read');
  const hasWrite = permissions.includes('vfs.write');
  if (!hasRead && !hasWrite) return undefined;
  // sandbox-rpc 一侧保证：声明了任一 vfs 权限 → vfsRoot 必有值。
  // 跑到这里还是 null 说明上游 wiring 坏了，比起静默返回 undefined 让 skill
  // 拿到 "vfs is undefined" 的迷糊错，宁愿在 sandbox 启动时直接炸出来。
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
  if (Object.keys(chromeProxy).length > 0 || permissions.some(p => p.startsWith('chrome.'))) {
    globals.chrome = chromeProxy;
  }

  // executeInPage function (if page.executeJs permission declared)
  if (permissions.includes('page.executeJs')) {
    globals.executeInPage = createPageExec(req.id, tabId);
  }

  // vfs proxy (if vfs.read or vfs.write permission declared)
  const vfsProxy = createVfsProxy(permissions, vfsRoot, req.id);
  if (vfsProxy) {
    globals.vfs = vfsProxy;
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
  }
});

// Signal ready to parent
window.parent.postMessage({ type: 'sandbox:ready' }, '*');

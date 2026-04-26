/**
 * Sandbox execution engine.
 * Runs skill scripts with dynamic code evaluation (allowed by sandbox CSP).
 * Chrome API calls are proxied back to the background via postMessage → offscreen → background.
 */

// ─── Message types (shared with sandbox-rpc.ts) ───

interface RunRequest {
  type: 'sandbox:run';
  id: string;
  code: string;
  args: Record<string, unknown>;
  permissions: string[];
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

// ─── Script Execution ───

async function executeScript(req: RunRequest): Promise<unknown> {
  const { code, args, permissions, tabId } = req;

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
  }
});

// Signal ready to parent
window.parent.postMessage({ type: 'sandbox:ready' }, '*');

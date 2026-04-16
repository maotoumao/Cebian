# Sandbox 执行引擎 + chrome_api 工具 + run_skill 重命名

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 skill 脚本在 sandbox 中执行（解决 CSP 限制），新增结构化 `chrome_api` 工具让 LLM 安全调用浏览器 API，并将 `execute_skill_code` 重命名为 `run_skill`。

**Architecture:** Sandbox page 通过 `window.parent.postMessage` 与嵌入它的扩展页面通信，但 background service worker 无法直接嵌入 iframe。因此采用"background ↔ offscreen document（宿主）↔ sandbox iframe"的三层架构。Offscreen document 作为消息中转站，background 通过 `chrome.runtime.sendMessage` 与 offscreen 通信，offscreen 内嵌 sandbox iframe 并通过 `postMessage` 转发。chrome_api 工具是独立的结构化工具，在 background 直接执行，不需要 sandbox。

**Tech Stack:** WXT sandbox entrypoints, postMessage RPC, Proxy-based chrome API 模拟, TypeBox schemas

---

## 文件结构

### 新建文件
- `entrypoints/sandbox/index.html` — WXT sandbox 入口 HTML
- `entrypoints/sandbox/main.ts` — Sandbox 内执行引擎 + chrome API Proxy
- `lib/tools/sandbox-rpc.ts` — Background ↔ Offscreen ↔ Sandbox 的 RPC 通信层
- `lib/tools/chrome-api-tool.ts` — 新增 `chrome_api` 结构化工具

### 修改文件
- `lib/types.ts` — 重命名常量 `TOOL_EXECUTE_SKILL_CODE` → `TOOL_RUN_SKILL`，新增 `TOOL_CHROME_API`
- `lib/tools/execute-skill-code.ts` — 重命名为概念上的 `run_skill`，移除 `new Function`，改为调用 sandbox RPC
- `lib/tools/index.ts` — 注册 `chrome_api` 工具
- `lib/tools/tool-labels.ts` — 更新标签
- `entrypoints/offscreen/main.ts` — 新增 sandbox iframe 宿主 + 消息中转逻辑

---

## Task 1: 重命名 execute_skill_code → run_skill

**Files:**
- Modify: `lib/types.ts`
- Modify: `lib/tools/execute-skill-code.ts`
- Modify: `lib/tools/index.ts`
- Modify: `lib/tools/tool-labels.ts`
- Modify: `lib/agent.ts` (如果有引用 tool name 字符串)

- [ ] **Step 1: 更新 types.ts 常量**

在 `lib/types.ts` 中：
```typescript
// 旧
export const TOOL_EXECUTE_SKILL_CODE = 'execute_skill_code';
// 新
export const TOOL_RUN_SKILL = 'run_skill';
```

- [ ] **Step 2: 更新 execute-skill-code.ts**

修改 `lib/tools/execute-skill-code.ts`：
- 将 import `TOOL_EXECUTE_SKILL_CODE` 改为 `TOOL_RUN_SKILL`
- 将 `name: TOOL_EXECUTE_SKILL_CODE` 改为 `name: TOOL_RUN_SKILL`
- 将 `label: 'Execute Skill Code'` 改为 `label: 'Run Skill'`
- 更新 description 中 "call execute_skill_code again" → "call run_skill again"

- [ ] **Step 3: 更新 index.ts 的导出名（如果有）**

检查 `lib/tools/index.ts` 是否使用了旧名。保持导入变量名 `executeSkillCodeTool` 不变（内部变量不影响功能，减少改动量）。

- [ ] **Step 4: 更新 tool-labels.ts**

```typescript
// 旧
case 'execute_skill_code':
  return `正在执行技能脚本 ${args.skill ?? ''}`;
// 新
case 'run_skill':
  return `正在执行技能脚本 ${args.skill ?? ''}`;
```

- [ ] **Step 5: 全局搜索残留引用**

搜索所有文件中 `execute_skill_code` 字符串，确保没有遗漏（agent.ts 的 system prompt 等）。

- [ ] **Step 6: 验证编译通过，commit**

```bash
# 验证无报错
npx tsc --noEmit
git add -A && git commit -m "refactor: rename execute_skill_code → run_skill"
```

---

## Task 2: 创建 Sandbox 入口页面

**Files:**
- Create: `entrypoints/sandbox/index.html`
- Create: `entrypoints/sandbox/main.ts`

- [ ] **Step 1: 创建 sandbox HTML 入口**

`entrypoints/sandbox/index.html`:
```html
<!doctype html>
<html>
  <head><meta charset="UTF-8" /></head>
  <body>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

WXT 会自动检测 `entrypoints/sandbox/index.html` 并添加到 `manifest.sandbox.pages`。

- [ ] **Step 2: 创建 sandbox 执行引擎**

`entrypoints/sandbox/main.ts`:

```typescript
/**
 * Sandbox execution engine.
 * Runs skill scripts with dynamic code evaluation (allowed by sandbox CSP).
 * Chrome API calls are proxied back to the background via postMessage → offscreen → background.
 */

// ─── Types ───

interface RunRequest {
  type: 'sandbox:run';
  id: string;
  code: string;
  args: Record<string, unknown>;
  permissions: string[];
  tabId?: number;
}

interface ChromeApiResponse {
  type: 'sandbox:chrome_result';
  id: string;
  callId: string;
  result?: unknown;
  error?: string;
}

interface RunResponse {
  type: 'sandbox:run_result';
  id: string;
  result?: unknown;
  error?: string;
}

interface ChromeApiRequest {
  type: 'sandbox:chrome_call';
  id: string;
  callId: string;
  namespace: string;
  method: string;
  args: unknown[];
}

interface PageExecRequest {
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

// ─── Chrome API Proxy ───

/** Pending chrome API calls waiting for response from background */
const pendingCalls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/** Current request ID (for routing chrome call responses) */
let currentRequestId: string | null = null;

function createChromeProxy(permissions: string[], requestId: string): Record<string, unknown> {
  const chromePerms = permissions.filter(p => p.startsWith('chrome.'));
  if (chromePerms.length === 0) return {};

  const allowedNamespaces = new Set(chromePerms.map(p => p.replace(/^chrome\./, '')));

  return new Proxy({} as Record<string, unknown>, {
    get(_target, ns: string) {
      if (!allowedNamespaces.has(ns)) return undefined;
      return new Proxy({}, {
        get(_t, method: string) {
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
              } satisfies ChromeApiRequest, '*');
            });
          };
        },
      });
    },
  });
}

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
      } satisfies PageExecRequest, '*');
    });
  };
}

// ─── Script Execution ───

async function executeScript(req: RunRequest): Promise<unknown> {
  currentRequestId = req.id;
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

  // Chrome API proxy
  const chromeProxy = createChromeProxy(permissions, req.id);
  if (Object.keys(chromeProxy).length > 0 || permissions.some(p => p.startsWith('chrome.'))) {
    globals.chrome = chromeProxy;
  }

  // executeInPage function
  if (permissions.includes('page.executeJs')) {
    globals.executeInPage = createPageExec(req.id, tabId);
  }

  // Result variable for natural script style
  let result: unknown = undefined;
  globals.result = undefined;

  // Build and execute
  const keys = Object.keys(globals);
  const values = keys.map(k => globals[k]);

  // Wrap code: supports both `result = xxx` style and `return xxx` style
  const wrappedCode = `return (async () => { ${code}\n; return typeof result !== 'undefined' ? result : undefined; })()`;
  const fn = new Function(...keys, wrappedCode);
  const execResult = await fn(...values);

  currentRequestId = null;
  return execResult;
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
        const serialized = result !== undefined ? JSON.parse(JSON.stringify(result)) : undefined;
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

// Signal ready
window.parent.postMessage({ type: 'sandbox:ready' }, '*');
```

- [ ] **Step 3: 验证 WXT 识别 sandbox 入口**

```bash
npx wxt build --dry-run 2>&1 | Select-String sandbox
```

确认 manifest 包含 `sandbox.pages`。

- [ ] **Step 4: commit**

```bash
git add -A && git commit -m "feat: add sandbox execution engine entrypoint"
```

---

## Task 3: Offscreen 中转层 — 宿主 sandbox iframe

**Files:**
- Modify: `entrypoints/offscreen/main.ts`
- Create: `lib/tools/sandbox-rpc.ts`

- [ ] **Step 1: 在 offscreen 中嵌入 sandbox iframe 并转发消息**

在 `entrypoints/offscreen/main.ts` 末尾添加 sandbox iframe 宿主逻辑：

```typescript
// ─── Sandbox iframe host ───
// The sandbox page cannot be embedded directly by the background SW.
// Offscreen document acts as host: embeds sandbox iframe and relays
// messages between background (chrome.runtime.onMessage) and sandbox (postMessage).

let sandboxFrame: HTMLIFrameElement | null = null;
let sandboxReady = false;
const pendingSandboxMessages: any[] = [];

function ensureSandboxFrame(): HTMLIFrameElement {
  if (sandboxFrame) return sandboxFrame;
  sandboxFrame = document.createElement('iframe');
  sandboxFrame.src = chrome.runtime.getURL('/sandbox.html');
  sandboxFrame.style.display = 'none';
  document.body.appendChild(sandboxFrame);
  return sandboxFrame;
}

// Relay messages from sandbox iframe → background
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'sandbox:ready') {
    sandboxReady = true;
    // Flush any messages that arrived before sandbox was ready
    for (const queued of pendingSandboxMessages) {
      sandboxFrame?.contentWindow?.postMessage(queued, '*');
    }
    pendingSandboxMessages.length = 0;
    return;
  }

  // Forward sandbox responses to background
  if (msg.type.startsWith('sandbox:')) {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
});

// Listen for messages from background to forward to sandbox
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type?.startsWith('sandbox:')) return false;

  // Messages TO sandbox (run, chrome_result, page_exec_result)
  if (message.type === 'sandbox:run' ||
      message.type === 'sandbox:chrome_result' ||
      message.type === 'sandbox:page_exec_result') {
    ensureSandboxFrame();
    if (sandboxReady) {
      sandboxFrame!.contentWindow?.postMessage(message, '*');
    } else {
      pendingSandboxMessages.push(message);
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
```

- [ ] **Step 2: 创建 sandbox-rpc.ts — Background 端 RPC 层**

`lib/tools/sandbox-rpc.ts`:

```typescript
/**
 * Background-side RPC layer for communicating with the sandbox page.
 * Path: background → chrome.runtime.sendMessage → offscreen → postMessage → sandbox
 * Reverse: sandbox → postMessage → offscreen → chrome.runtime.sendMessage → background
 */

import { ensureOffscreen } from './offscreen';
import { resolveTabId, executeViaDebugger } from './chrome-api';

// ─── Types (shared with sandbox/main.ts) ───

interface SandboxRunRequest {
  type: 'sandbox:run';
  id: string;
  code: string;
  args: Record<string, unknown>;
  permissions: string[];
  tabId?: number;
}

interface SandboxRunResult {
  type: 'sandbox:run_result';
  id: string;
  result?: unknown;
  error?: string;
}

interface SandboxChromeCall {
  type: 'sandbox:chrome_call';
  id: string;
  callId: string;
  namespace: string;
  method: string;
  args: unknown[];
}

interface SandboxPageExec {
  type: 'sandbox:page_exec';
  id: string;
  callId: string;
  code: string;
  tabId?: number;
}

// ─── Chrome API whitelist ───

const CHROME_API_WHITELIST = new Set([
  'tabs.query', 'tabs.get', 'tabs.create', 'tabs.update', 'tabs.remove', 'tabs.reload',
  'tabs.captureVisibleTab',
  'windows.getAll', 'windows.get', 'windows.create', 'windows.update', 'windows.remove',
  'storage.local.get', 'storage.local.set', 'storage.local.remove',
  'storage.sync.get', 'storage.sync.set', 'storage.sync.remove',
  'bookmarks.getTree', 'bookmarks.get', 'bookmarks.search', 'bookmarks.create',
  'bookmarks.update', 'bookmarks.remove',
  'history.search', 'history.getVisits', 'history.deleteUrl',
  'cookies.get', 'cookies.getAll', 'cookies.set', 'cookies.remove',
  'alarms.get', 'alarms.getAll', 'alarms.create', 'alarms.clear', 'alarms.clearAll',
  'notifications.create', 'notifications.clear',
  'scripting.executeScript',
  'debugger.attach', 'debugger.detach', 'debugger.sendCommand',
  'webNavigation.getFrame', 'webNavigation.getAllFrames',
]);

function isAllowedChromeCall(namespace: string, method: string): boolean {
  return CHROME_API_WHITELIST.has(`${namespace}.${method}`);
}

// ─── Pending run requests ───

const pendingRuns = new Map<string, {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}>();

// ─── Handle messages from sandbox (via offscreen relay) ───

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type?.startsWith('sandbox:')) return false;

  switch (message.type) {
    case 'sandbox:run_result': {
      const msg = message as SandboxRunResult;
      const pending = pendingRuns.get(msg.id);
      if (pending) {
        pendingRuns.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.result);
        }
      }
      return false;
    }

    case 'sandbox:chrome_call': {
      const msg = message as SandboxChromeCall;
      handleChromeCall(msg).catch(() => {});
      return false;
    }

    case 'sandbox:page_exec': {
      const msg = message as SandboxPageExec;
      handlePageExec(msg).catch(() => {});
      return false;
    }
  }

  return false;
});

async function handleChromeCall(msg: SandboxChromeCall): Promise<void> {
  let result: unknown;
  let error: string | undefined;

  try {
    if (!isAllowedChromeCall(msg.namespace, msg.method)) {
      throw new Error(`Chrome API call not allowed: chrome.${msg.namespace}.${msg.method}`);
    }

    const ns = (chrome as any)[msg.namespace];
    if (!ns) throw new Error(`Unknown chrome namespace: ${msg.namespace}`);

    // Handle nested namespaces (e.g. storage.local.get)
    const parts = msg.method.split('.');
    let target = ns;
    for (let i = 0; i < parts.length - 1; i++) {
      target = target[parts[i]];
      if (!target) throw new Error(`Unknown path: chrome.${msg.namespace}.${msg.method}`);
    }
    const finalMethod = parts[parts.length - 1];

    if (typeof target[finalMethod] !== 'function') {
      throw new Error(`Not a function: chrome.${msg.namespace}.${msg.method}`);
    }

    result = await target[finalMethod](...msg.args);
  } catch (err) {
    error = (err as Error).message;
  }

  // Send result back to sandbox via offscreen
  await chrome.runtime.sendMessage({
    type: 'sandbox:chrome_result',
    id: msg.id,
    callId: msg.callId,
    result,
    error,
  }).catch(() => {});
}

async function handlePageExec(msg: SandboxPageExec): Promise<void> {
  let resultText: string | undefined;
  let error: string | undefined;

  try {
    const tabId = await resolveTabId(msg.tabId);
    resultText = await executeViaDebugger(tabId, msg.code);
  } catch (err) {
    error = (err as Error).message;
  }

  await chrome.runtime.sendMessage({
    type: 'sandbox:page_exec_result',
    id: msg.id,
    callId: msg.callId,
    result: resultText,
    error,
  }).catch(() => {});
}

// ─── Public API ───

/**
 * Execute a skill script in the sandbox page.
 * Manages the full lifecycle: ensure offscreen → send to sandbox → await result.
 */
export async function runInSandbox(
  code: string,
  args: Record<string, unknown>,
  permissions: string[],
  tabId?: number,
): Promise<unknown> {
  await ensureOffscreen();

  const id = crypto.randomUUID();

  const resultPromise = new Promise<unknown>((resolve, reject) => {
    pendingRuns.set(id, { resolve, reject });
    // Timeout after 5 minutes
    setTimeout(() => {
      if (pendingRuns.has(id)) {
        pendingRuns.delete(id);
        reject(new Error('Sandbox execution timed out (5 min)'));
      }
    }, 5 * 60 * 1000);
  });

  // Send to offscreen (which relays to sandbox iframe)
  await chrome.runtime.sendMessage({
    type: 'sandbox:run',
    id,
    code,
    args,
    permissions,
    tabId,
  } satisfies SandboxRunRequest);

  return resultPromise;
}
```

- [ ] **Step 3: commit**

```bash
git add -A && git commit -m "feat: sandbox RPC layer (background ↔ offscreen ↔ sandbox)"
```

---

## Task 4: 改造 run_skill 工具使用 sandbox

**Files:**
- Modify: `lib/tools/execute-skill-code.ts`

- [ ] **Step 1: 替换 new Function 执行为 sandbox RPC**

在 `lib/tools/execute-skill-code.ts` 中：

1. 移除 `buildSandbox` 函数和 `BASE_SANDBOX_KEYS` 常量
2. 移除 `import { resolveTabId, executeViaDebugger } from './chrome-api'`
3. 新增 `import { runInSandbox } from './sandbox-rpc'`
4. 替换第 ④ 步执行逻辑：

旧代码（移除）:
```typescript
// ─── ④ Build sandbox and execute ───
// TODO: new Function() may be blocked by MV3 CSP in background SW.
// Fallback: execute in a sandboxed page via postMessage.

try {
  const { keys, values } = buildSandbox(permissions, args as Record<string, unknown>, tabId);
  const fn = new Function(...keys, `return (async () => { ${code} })()`);
  const result = await fn(...values);
  const serialized = result !== undefined ? JSON.stringify(result, null, 2) : '(no return value)';
  ...
```

新代码:
```typescript
// ─── ④ Execute in sandbox ───

try {
  const result = await runInSandbox(code, args as Record<string, unknown>, permissions, tabId);
  const serialized = result !== undefined ? JSON.stringify(result, null, 2) : '(no return value)';

  return {
    content: [{ type: 'text', text: serialized }],
    details: { status: 'done' },
  };
} catch (err) {
  return {
    content: [{ type: 'text', text: `Script execution error: ${(err as Error).message}` }],
    details: { status: 'error' },
  };
}
```

- [ ] **Step 2: 更新工具 description**

将 description 中 "The script runs as an async function body — use `return` to produce a result" 改为：
"The script runs as a complete JavaScript file. Use `result = value` to set the return value, or `return value` at the end."

- [ ] **Step 3: 验证编译通过，commit**

```bash
npx tsc --noEmit
git add -A && git commit -m "refactor: run_skill uses sandbox execution instead of new Function"
```

---

## Task 5: 新增 chrome_api 结构化工具

**Files:**
- Create: `lib/tools/chrome-api-tool.ts`
- Modify: `lib/types.ts`
- Modify: `lib/tools/index.ts`
- Modify: `lib/tools/tool-labels.ts`

- [ ] **Step 1: 添加常量**

`lib/types.ts`:
```typescript
export const TOOL_CHROME_API = 'chrome_api';
```

- [ ] **Step 2: 创建 chrome_api 工具**

`lib/tools/chrome-api-tool.ts`:

```typescript
import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_CHROME_API } from '@/lib/types';

// ─── Whitelist: allowed chrome.* API calls ───
// Read-only operations are allowed freely.
// Write operations are included but gated by confirmBeforeExec setting.

const ALLOWED_APIS: Record<string, Set<string>> = {
  tabs: new Set(['query', 'get', 'create', 'update', 'remove', 'reload', 'captureVisibleTab']),
  windows: new Set(['getAll', 'get', 'create', 'update', 'remove', 'getCurrent', 'getLastFocused']),
  bookmarks: new Set(['getTree', 'getChildren', 'get', 'search', 'create', 'update', 'remove', 'move']),
  history: new Set(['search', 'getVisits', 'addUrl', 'deleteUrl', 'deleteRange', 'deleteAll']),
  cookies: new Set(['get', 'getAll', 'set', 'remove', 'getAllCookieStores']),
  storage: new Set(['local', 'sync', 'session']),  // sub-namespaces handled specially
  topSites: new Set(['get']),
  sessions: new Set(['getRecentlyClosed', 'getDevices', 'restore']),
  downloads: new Set(['search', 'pause', 'resume', 'cancel', 'getFileIcon', 'download']),
  alarms: new Set(['get', 'getAll', 'create', 'clear', 'clearAll']),
  notifications: new Set(['create', 'update', 'clear', 'getAll', 'getPermissionLevel']),
  webNavigation: new Set(['getFrame', 'getAllFrames']),
};

const STORAGE_METHODS = new Set(['get', 'set', 'remove', 'clear', 'getBytesInUse', 'getKeys']);

function isAllowed(namespace: string, method: string): boolean {
  // Handle storage.local.get, storage.sync.set, etc.
  if (namespace === 'storage') {
    const parts = method.split('.');
    if (parts.length === 2) {
      const [area, fn] = parts;
      return (ALLOWED_APIS.storage?.has(area) ?? false) && STORAGE_METHODS.has(fn);
    }
    return false;
  }
  return ALLOWED_APIS[namespace]?.has(method) ?? false;
}

// ─── Parameter schema ───

const ChromeApiParameters = Type.Object({
  namespace: Type.String({
    description:
      'Chrome API namespace (e.g. "tabs", "bookmarks", "history", "cookies", "storage", "windows", "downloads"). ' +
      'Must be a supported namespace.',
  }),
  method: Type.String({
    description:
      'Method name to call (e.g. "query", "search", "get", "create"). ' +
      'For storage, use "local.get", "sync.set", etc.',
  }),
  args: Type.Optional(Type.Array(Type.Unknown(), {
    description:
      'Arguments to pass to the method. Each element is one argument. ' +
      'Example for tabs.query: [{"active": true, "currentWindow": true}]. ' +
      'Example for bookmarks.search: ["recipe"]. ' +
      'Omit for methods with no arguments (e.g. topSites.get).',
  })),
});

// ─── Tool definition ───

export const chromeApiTool: AgentTool<typeof ChromeApiParameters> = {
  name: TOOL_CHROME_API,
  label: 'Chrome API',
  description:
    'Call Chrome browser APIs directly. ' +
    'Use for: querying tabs/windows, searching bookmarks/history, ' +
    'reading/writing cookies, managing downloads, storage operations, etc. ' +
    'Supported namespaces: tabs, windows, bookmarks, history, cookies, ' +
    'storage (local/sync/session), topSites, sessions, downloads, alarms, notifications, webNavigation. ' +
    'Arguments are passed as an array — each element is one function argument. ' +
    'Returns the JSON-serialized result.',
  parameters: ChromeApiParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    const { namespace, method, args = [] } = params;

    // Validate against whitelist
    if (!isAllowed(namespace, method)) {
      return {
        content: [{
          type: 'text',
          text: `Error: chrome.${namespace}.${method} is not allowed. ` +
            `Allowed namespaces: ${Object.keys(ALLOWED_APIS).join(', ')}`,
        }],
        details: { status: 'error' },
      };
    }

    try {
      let target: any = (chrome as any)[namespace];
      if (!target) {
        return {
          content: [{ type: 'text', text: `Error: chrome.${namespace} is not available.` }],
          details: { status: 'error' },
        };
      }

      // Resolve nested method path (e.g. storage → local → get)
      const parts = method.split('.');
      for (let i = 0; i < parts.length - 1; i++) {
        target = target[parts[i]];
        if (!target) {
          return {
            content: [{ type: 'text', text: `Error: chrome.${namespace}.${method} not found.` }],
            details: { status: 'error' },
          };
        }
      }

      const finalMethod = parts[parts.length - 1];
      if (typeof target[finalMethod] !== 'function') {
        return {
          content: [{ type: 'text', text: `Error: chrome.${namespace}.${method} is not a function.` }],
          details: { status: 'error' },
        };
      }

      const result = await target[finalMethod](...args);
      const text = result !== undefined ? JSON.stringify(result, null, 2) : '(no return value)';

      return {
        content: [{ type: 'text', text }],
        details: { status: 'done' },
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        details: { status: 'error' },
      };
    }
  },
};
```

- [ ] **Step 3: 注册到工具列表**

`lib/tools/index.ts` — 在 sharedTools 数组中添加 `chromeApiTool`:

```typescript
import { chromeApiTool } from './chrome-api-tool';

const sharedTools: AgentTool<any>[] = [
  executeJsTool, readPageTool, interactTool, tabTool, screenshotTool,
  fsCreateFileTool, fsEditFileTool, fsMkdirTool, fsRenameTool, fsDeleteTool,
  fsReadFileTool, fsListTool, fsSearchTool,
  executeSkillCodeTool,
  chromeApiTool,
];
```

- [ ] **Step 4: 添加 tool label**

`lib/tools/tool-labels.ts`:
```typescript
case 'chrome_api':
  return `正在调用 chrome.${args.namespace ?? ''}.${args.method ?? ''}`;
```

- [ ] **Step 5: 验证编译通过，commit**

```bash
npx tsc --noEmit
git add -A && git commit -m "feat: add chrome_api structured tool with whitelist"
```

---

## Task 6: 更新 system prompt 中的工具说明

**Files:**
- Modify: `lib/agent.ts` 或 `lib/constants.ts`（wherever DEFAULT_SYSTEM_PROMPT is defined）

- [ ] **Step 1: 找到 system prompt 并检查是否引用旧工具名**

搜索 `execute_skill_code` 在 system prompt 或 agent 配置中的引用，更新为 `run_skill`。

- [ ] **Step 2: 如果 system prompt 列出了可用工具，添加 chrome_api 说明**

在适当位置添加类似：

```
- chrome_api: 直接调用 Chrome 浏览器 API（标签页、书签、历史记录、Cookies、存储等）。使用结构化参数：namespace + method + args。
```

- [ ] **Step 3: commit**

```bash
git add -A && git commit -m "docs: update system prompt for run_skill + chrome_api"
```

---

## Task 7: 集成验证

- [ ] **Step 1: 启动 dev 模式，验证 manifest 包含 sandbox**

```bash
npm run dev
```

检查 `.output/chrome-mv3/manifest.json` 中是否有 `sandbox.pages` 字段。

- [ ] **Step 2: 测试 chrome_api 工具**

在侧边栏中让 agent 执行：
- "帮我查看所有打开的标签页" → 应调用 `chrome_api({namespace:"tabs", method:"query", args:[{}]})`
- "搜索我的书签中有没有 GitHub" → 应调用 `chrome_api({namespace:"bookmarks", method:"search", args:["GitHub"]})`

- [ ] **Step 3: 测试 run_skill 工具（sandbox 执行）**

创建一个测试 skill 并让 agent 调用。验证：
- 脚本在 sandbox 中执行（无 CSP 报错）
- `result = xxx` 赋值方式正常工作
- `chrome.tabs.query()` 代理回 background 正常工作
- `executeInPage('document.title')` 正常工作

- [ ] **Step 4: 最终 commit**

```bash
git add -A && git commit -m "feat: sandbox execution engine + chrome_api tool complete"
```

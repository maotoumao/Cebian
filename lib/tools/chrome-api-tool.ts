import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_CHROME_API } from '@/lib/types';

// ─── Whitelist: allowed chrome.* API calls ───
// Only APIs whose permission is declared in manifest are included.
// To add new namespaces, also add the permission in wxt.config.ts.

const ALLOWED_APIS: Record<string, Set<string>> = {
  tabs: new Set([
    'query', 'get', 'create', 'update', 'remove', 'reload',
    'captureVisibleTab', 'duplicate', 'move', 'group', 'ungroup',
  ]),
  windows: new Set([
    'getAll', 'get', 'create', 'update', 'remove',
    'getCurrent', 'getLastFocused',
  ]),
  alarms: new Set(['get', 'getAll', 'create', 'clear', 'clearAll']),
  webNavigation: new Set(['getFrame', 'getAllFrames']),
  bookmarks: new Set(['getTree', 'getChildren', 'get', 'search', 'create', 'update', 'remove', 'move']),
  history: new Set(['search', 'getVisits', 'addUrl', 'deleteUrl', 'deleteRange']),
  cookies: new Set(['get', 'getAll', 'set', 'remove', 'getAllCookieStores']),
  topSites: new Set(['get']),
  sessions: new Set(['getRecentlyClosed', 'getDevices', 'restore']),
  downloads: new Set(['search', 'pause', 'resume', 'cancel', 'download']),
  notifications: new Set(['create', 'update', 'clear', 'getAll', 'getPermissionLevel']),
};

/** Parts that must never appear in method paths (prototype pollution guard) */
const FORBIDDEN_PATH_PARTS = new Set(['__proto__', 'constructor', 'prototype']);

function isAllowed(namespace: string, method: string): boolean {
  // Block prototype pollution attempts
  const parts = method.split('.');
  if (parts.some(p => FORBIDDEN_PATH_PARTS.has(p))) return false;

  // Flat method names only (no dots)
  if (method.includes('.')) return false;

  return ALLOWED_APIS[namespace]?.has(method) ?? false;
}

// ─── API documentation for help mode ───

interface MethodDoc {
  signature: string;
  params: string;
  example: string;
}

const API_DOCS: Record<string, { summary: string; methods: Record<string, MethodDoc> }> = {
  tabs: {
    summary: 'Query, create, update, remove, reload browser tabs',
    methods: {
      query: {
        signature: 'query(queryInfo)',
        params: 'queryInfo: {active?: boolean, currentWindow?: boolean, url?: string | string[], status?: "loading" | "complete", title?: string, windowId?: number, pinned?: boolean, index?: number}',
        example: 'args: [{"active": true, "currentWindow": true}]',
      },
      get: {
        signature: 'get(tabId)',
        params: 'tabId: number',
        example: 'args: [123]',
      },
      create: {
        signature: 'create(createProperties)',
        params: 'createProperties: {url?: string, active?: boolean, windowId?: number, index?: number, pinned?: boolean}',
        example: 'args: [{"url": "https://example.com"}]',
      },
      update: {
        signature: 'update(tabId, updateProperties)',
        params: 'tabId: number, updateProperties: {url?: string, active?: boolean, pinned?: boolean, muted?: boolean}',
        example: 'args: [123, {"active": true}]',
      },
      remove: {
        signature: 'remove(tabIds)',
        params: 'tabIds: number | number[]',
        example: 'args: [123]  or  args: [[123, 456]]',
      },
      reload: {
        signature: 'reload(tabId?, reloadProperties?)',
        params: 'tabId?: number (omit for active tab), reloadProperties?: {bypassCache?: boolean}',
        example: 'args: []  or  args: [123]  or  args: [123, {"bypassCache": true}]',
      },
      captureVisibleTab: {
        signature: 'captureVisibleTab(windowId?, options?)',
        params: 'windowId?: number, options?: {format?: "jpeg" | "png", quality?: number}',
        example: 'args: []  or  args: [null, {"format": "jpeg", "quality": 80}]',
      },
      duplicate: {
        signature: 'duplicate(tabId)',
        params: 'tabId: number',
        example: 'args: [123]',
      },
      move: {
        signature: 'move(tabIds, moveProperties)',
        params: 'tabIds: number | number[], moveProperties: {windowId?: number, index: number}',
        example: 'args: [123, {"index": 0}]',
      },
      group: {
        signature: 'group(options)',
        params: 'options: {tabIds: number | number[], groupId?: number}',
        example: 'args: [{"tabIds": [123, 456]}]',
      },
      ungroup: {
        signature: 'ungroup(tabIds)',
        params: 'tabIds: number | number[]',
        example: 'args: [[123, 456]]',
      },
    },
  },
  windows: {
    summary: 'Manage browser windows',
    methods: {
      getAll: {
        signature: 'getAll(getInfo?)',
        params: 'getInfo?: {populate?: boolean, windowTypes?: ("normal" | "popup" | "app" | "devtools")[]}',
        example: 'args: []  or  args: [{"populate": true}]',
      },
      get: {
        signature: 'get(windowId, getInfo?)',
        params: 'windowId: number, getInfo?: {populate?: boolean}',
        example: 'args: [1]  or  args: [1, {"populate": true}]',
      },
      create: {
        signature: 'create(createData?)',
        params: 'createData?: {url?: string | string[], tabId?: number, left?: number, top?: number, width?: number, height?: number, focused?: boolean, incognito?: boolean, type?: "normal" | "popup"}',
        example: 'args: [{"url": "https://example.com", "width": 800, "height": 600}]',
      },
      update: {
        signature: 'update(windowId, updateInfo)',
        params: 'windowId: number, updateInfo: {left?: number, top?: number, width?: number, height?: number, focused?: boolean, state?: "normal" | "minimized" | "maximized" | "fullscreen"}',
        example: 'args: [1, {"focused": true}]',
      },
      remove: {
        signature: 'remove(windowId)',
        params: 'windowId: number',
        example: 'args: [1]',
      },
      getCurrent: {
        signature: 'getCurrent(getInfo?)',
        params: 'getInfo?: {populate?: boolean}',
        example: 'args: []',
      },
      getLastFocused: {
        signature: 'getLastFocused(getInfo?)',
        params: 'getInfo?: {populate?: boolean}',
        example: 'args: []',
      },
    },
  },
  bookmarks: {
    summary: 'Search, read, create, update bookmarks',
    methods: {
      getTree: {
        signature: 'getTree()',
        params: '(no arguments)',
        example: 'args: []',
      },
      getChildren: {
        signature: 'getChildren(id)',
        params: 'id: string — parent bookmark folder ID ("0" for root, "1" for bookmarks bar, "2" for other bookmarks)',
        example: 'args: ["1"]',
      },
      get: {
        signature: 'get(idOrIdList)',
        params: 'idOrIdList: string | string[]',
        example: 'args: ["1"]  or  args: [["1", "2"]]',
      },
      search: {
        signature: 'search(query)',
        params: 'query: string | {query?: string, url?: string, title?: string}',
        example: 'args: ["GitHub"]  or  args: [{"query": "GitHub"}]',
      },
      create: {
        signature: 'create(bookmark)',
        params: 'bookmark: {parentId?: string, index?: number, title?: string, url?: string} — omit url to create a folder',
        example: 'args: [{"parentId": "1", "title": "My Site", "url": "https://example.com"}]',
      },
      update: {
        signature: 'update(id, changes)',
        params: 'id: string, changes: {title?: string, url?: string}',
        example: 'args: ["123", {"title": "New Title"}]',
      },
      remove: {
        signature: 'remove(id)',
        params: 'id: string',
        example: 'args: ["123"]',
      },
      move: {
        signature: 'move(id, destination)',
        params: 'id: string, destination: {parentId?: string, index?: number}',
        example: 'args: ["123", {"parentId": "1", "index": 0}]',
      },
    },
  },
  history: {
    summary: 'Search and manage browsing history',
    methods: {
      search: {
        signature: 'search(query)',
        params: 'query: {text: string, startTime?: number, endTime?: number, maxResults?: number} — text is required (use "" for all)',
        example: 'args: [{"text": "", "maxResults": 20}]  or  args: [{"text": "GitHub"}]',
      },
      getVisits: {
        signature: 'getVisits(details)',
        params: 'details: {url: string}',
        example: 'args: [{"url": "https://github.com"}]',
      },
      addUrl: {
        signature: 'addUrl(details)',
        params: 'details: {url: string}',
        example: 'args: [{"url": "https://example.com"}]',
      },
      deleteUrl: {
        signature: 'deleteUrl(details)',
        params: 'details: {url: string}',
        example: 'args: [{"url": "https://example.com"}]',
      },
      deleteRange: {
        signature: 'deleteRange(range)',
        params: 'range: {startTime: number, endTime: number} — timestamps in ms since epoch',
        example: 'args: [{"startTime": 1700000000000, "endTime": 1700086400000}]',
      },
    },
  },
  cookies: {
    summary: 'Read and manage browser cookies',
    methods: {
      get: {
        signature: 'get(details)',
        params: 'details: {url: string, name: string, storeId?: string}',
        example: 'args: [{"url": "https://example.com", "name": "session_id"}]',
      },
      getAll: {
        signature: 'getAll(details)',
        params: 'details: {url?: string, name?: string, domain?: string, path?: string, secure?: boolean, session?: boolean, storeId?: string}',
        example: 'args: [{"domain": "example.com"}]  or  args: [{"url": "https://example.com"}]',
      },
      set: {
        signature: 'set(details)',
        params: 'details: {url: string, name: string, value?: string, domain?: string, path?: string, secure?: boolean, httpOnly?: boolean, sameSite?: "no_restriction" | "lax" | "strict", expirationDate?: number, storeId?: string}',
        example: 'args: [{"url": "https://example.com", "name": "test", "value": "123"}]',
      },
      remove: {
        signature: 'remove(details)',
        params: 'details: {url: string, name: string, storeId?: string}',
        example: 'args: [{"url": "https://example.com", "name": "session_id"}]',
      },
      getAllCookieStores: {
        signature: 'getAllCookieStores()',
        params: '(no arguments)',
        example: 'args: []',
      },
    },
  },
  topSites: {
    summary: 'Get most frequently visited sites',
    methods: {
      get: {
        signature: 'get()',
        params: '(no arguments)',
        example: 'args: []',
      },
    },
  },
  sessions: {
    summary: 'Access recently closed tabs and windows',
    methods: {
      getRecentlyClosed: {
        signature: 'getRecentlyClosed(filter?)',
        params: 'filter?: {maxResults?: number}',
        example: 'args: []  or  args: [{"maxResults": 10}]',
      },
      getDevices: {
        signature: 'getDevices(filter?)',
        params: 'filter?: {maxResults?: number}',
        example: 'args: []',
      },
      restore: {
        signature: 'restore(sessionId?)',
        params: 'sessionId?: string — from getRecentlyClosed results',
        example: 'args: ["session_123"]',
      },
    },
  },
  downloads: {
    summary: 'Query and manage file downloads',
    methods: {
      search: {
        signature: 'search(query)',
        params: 'query: {query?: string[], id?: number, url?: string, filename?: string, state?: "in_progress" | "interrupted" | "complete", limit?: number, orderBy?: string[]}',
        example: 'args: [{}]  or  args: [{"state": "complete", "limit": 10}]',
      },
      pause: {
        signature: 'pause(downloadId)',
        params: 'downloadId: number',
        example: 'args: [123]',
      },
      resume: {
        signature: 'resume(downloadId)',
        params: 'downloadId: number',
        example: 'args: [123]',
      },
      cancel: {
        signature: 'cancel(downloadId)',
        params: 'downloadId: number',
        example: 'args: [123]',
      },
      download: {
        signature: 'download(options)',
        params: 'options: {url: string, filename?: string, saveAs?: boolean, method?: "GET" | "POST", headers?: {name: string, value: string}[], body?: string}',
        example: 'args: [{"url": "https://example.com/file.pdf"}]',
      },
    },
  },
  alarms: {
    summary: 'Create and manage scheduled alarms',
    methods: {
      get: {
        signature: 'get(name?)',
        params: 'name?: string — alarm name, omit to get unnamed alarm',
        example: 'args: ["myAlarm"]',
      },
      getAll: {
        signature: 'getAll()',
        params: '(no arguments)',
        example: 'args: []',
      },
      create: {
        signature: 'create(name?, alarmInfo)',
        params: 'name?: string, alarmInfo: {when?: number, delayInMinutes?: number, periodInMinutes?: number} — at least one of when/delayInMinutes required, periodInMinutes for repeating',
        example: 'args: ["reminder", {"delayInMinutes": 5}]  or  args: [{"delayInMinutes": 1, "periodInMinutes": 60}]',
      },
      clear: {
        signature: 'clear(name?)',
        params: 'name?: string',
        example: 'args: ["myAlarm"]',
      },
      clearAll: {
        signature: 'clearAll()',
        params: '(no arguments)',
        example: 'args: []',
      },
    },
  },
  notifications: {
    summary: 'Create and manage desktop notifications',
    methods: {
      create: {
        signature: 'create(notificationId?, options)',
        params: 'notificationId?: string (auto-generated if omitted), options: {type: "basic" | "image" | "list" | "progress", iconUrl: string, title: string, message: string, contextMessage?: string, priority?: 0|1|2, buttons?: {title: string}[], imageUrl?: string, items?: {title: string, message: string}[], progress?: number}',
        example: 'args: ["myNotif", {"type": "basic", "iconUrl": "icon.png", "title": "Hello", "message": "World"}]',
      },
      update: {
        signature: 'update(notificationId, options)',
        params: 'notificationId: string, options: same as create options',
        example: 'args: ["myNotif", {"title": "Updated"}]',
      },
      clear: {
        signature: 'clear(notificationId)',
        params: 'notificationId: string',
        example: 'args: ["myNotif"]',
      },
      getAll: {
        signature: 'getAll()',
        params: '(no arguments)',
        example: 'args: []',
      },
      getPermissionLevel: {
        signature: 'getPermissionLevel()',
        params: '(no arguments)',
        example: 'args: []',
      },
    },
  },
  webNavigation: {
    summary: 'Inspect page frames and navigation',
    methods: {
      getFrame: {
        signature: 'getFrame(details)',
        params: 'details: {tabId: number, frameId: number}',
        example: 'args: [{"tabId": 123, "frameId": 0}]',
      },
      getAllFrames: {
        signature: 'getAllFrames(details)',
        params: 'details: {tabId: number}',
        example: 'args: [{"tabId": 123}]',
      },
    },
  },
};

function formatHelpList(): string {
  const lines = ['Available Chrome API namespaces:\n'];
  for (const [ns, doc] of Object.entries(API_DOCS)) {
    const methodCount = Object.keys(doc.methods).length;
    lines.push(`  ${ns} (${methodCount} methods) — ${doc.summary}`);
  }
  lines.push('\nUse chrome_api({namespace:"help", method:"<namespace>"}) to see method signatures and examples.');
  return lines.join('\n');
}

function formatHelpNamespace(ns: string): string {
  const doc = API_DOCS[ns];
  if (!doc) return `Unknown namespace: "${ns}". Use method="list" to see all available namespaces.`;
  const lines = [`chrome.${ns} — ${doc.summary}\n`];
  for (const [name, m] of Object.entries(doc.methods)) {
    lines.push(`  ${m.signature}`);
    lines.push(`    ${m.params}`);
    lines.push(`    ${m.example}\n`);
  }
  return lines.join('\n');
}

// ─── Parameter schema ───

const ChromeApiParameters = Type.Object({
  namespace: Type.String({
    description:
      'Chrome API namespace (e.g. "tabs", "windows", "storage", "alarms", "webNavigation").',
  }),
  method: Type.String({
    description:
      'Method name to call (e.g. "query", "get", "create", "search").',
  }),
  args: Type.Optional(Type.Array(Type.Unknown(), {
    description:
      'Arguments array. Each element is one function argument. ' +
      'Example for tabs.query: [{"active": true, "currentWindow": true}]. ' +
      'Omit for methods with no arguments.',
  })),
});

// ─── Tool definition ───

export const chromeApiTool: AgentTool<typeof ChromeApiParameters> = {
  name: TOOL_CHROME_API,
  label: 'Chrome API',
  description:
    'Call Chrome browser APIs directly via structured parameters. ' +
    'Use for: querying/managing tabs and windows, bookmarks, browsing history, cookies, ' +
    'downloads, alarms, notifications, sessions, top sites, and frame inspection. ' +
    'Supported namespaces: tabs, windows, bookmarks, history, cookies, ' +
    'topSites, sessions, downloads, alarms, notifications, webNavigation. ' +
    'Arguments are passed as an array — each element is one function argument. ' +
    'Get tab IDs and window IDs from the context block. ' +
    'IMPORTANT: If unsure about argument format, first call with namespace="help" and method=<namespace> ' +
    'to see method signatures and examples. Use method="list" to see all available namespaces. ' +
    'Returns the JSON-serialized result.',
  parameters: ChromeApiParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    const { namespace, method, args = [] } = params;

    // Handle help requests — return API documentation
    if (namespace === 'help') {
      if (method === 'list') {
        return { content: [{ type: 'text', text: formatHelpList() }], details: { status: 'done' } };
      }
      return { content: [{ type: 'text', text: formatHelpNamespace(method) }], details: { status: 'done' } };
    }

    // Validate against whitelist
    if (!isAllowed(namespace, method)) {
      const supported = Object.keys(ALLOWED_APIS).join(', ');
      return {
        content: [{
          type: 'text',
          text: `Error: chrome.${namespace}.${method} is not allowed. Supported namespaces: ${supported}.`,
        }],
        details: { status: 'error' },
      };
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic chrome API access
      let target: any = (chrome as any)[namespace];
      if (!target) {
        return {
          content: [{ type: 'text', text: `Error: chrome.${namespace} is not available in this environment.` }],
          details: { status: 'error' },
        };
      }

      // Resolve nested method path (e.g. storage → local → get)
      const parts = method.split('.');
      for (let i = 0; i < parts.length - 1; i++) {
        target = target[parts[i]];
        if (!target) {
          return {
            content: [{ type: 'text', text: `Error: chrome.${namespace}.${method} path not found.` }],
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

      let text: string;
      try {
        text = result !== undefined ? JSON.stringify(result, null, 2) : '(no return value)';
      } catch {
        text = `(result returned but could not be serialized — type: ${typeof result})`;
      }

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

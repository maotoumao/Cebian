/**
 * Background-side RPC layer for communicating with the sandbox page.
 * Path: background → chrome.runtime.sendMessage → offscreen → postMessage → sandbox
 * Reverse: sandbox → postMessage → offscreen → chrome.runtime.sendMessage → background
 */

import { ensureOffscreen } from './offscreen';
import { resolveTabId, executeViaDebugger } from './chrome-api';

// ─── Chrome API whitelist (shared with chrome-api-tool.ts ALLOWED_APIS) ───

const SANDBOX_CHROME_WHITELIST = new Set([
  // tabs
  'tabs.query', 'tabs.get', 'tabs.create', 'tabs.update', 'tabs.remove', 'tabs.reload',
  'tabs.captureVisibleTab', 'tabs.duplicate', 'tabs.move', 'tabs.group', 'tabs.ungroup',
  // windows
  'windows.getAll', 'windows.get', 'windows.create', 'windows.update', 'windows.remove',
  'windows.getCurrent', 'windows.getLastFocused',
  // alarms
  'alarms.get', 'alarms.getAll', 'alarms.create', 'alarms.clear', 'alarms.clearAll',
  // webNavigation
  'webNavigation.getFrame', 'webNavigation.getAllFrames',
  // bookmarks
  'bookmarks.getTree', 'bookmarks.getChildren', 'bookmarks.get', 'bookmarks.search',
  'bookmarks.create', 'bookmarks.update', 'bookmarks.remove', 'bookmarks.move',
  // history
  'history.search', 'history.getVisits', 'history.addUrl', 'history.deleteUrl', 'history.deleteRange',
  // cookies
  'cookies.get', 'cookies.getAll', 'cookies.set', 'cookies.remove', 'cookies.getAllCookieStores',
  // topSites
  'topSites.get',
  // sessions
  'sessions.getRecentlyClosed', 'sessions.getDevices', 'sessions.restore',
  // downloads
  'downloads.search', 'downloads.pause', 'downloads.resume', 'downloads.cancel', 'downloads.download',
  // notifications
  'notifications.create', 'notifications.update', 'notifications.clear',
  'notifications.getAll', 'notifications.getPermissionLevel',
  // debugger (for executeInPage)
  'debugger.attach', 'debugger.detach', 'debugger.sendCommand',
  // scripting
  'scripting.executeScript',
]);

function isChromeCallAllowed(namespace: string, method: string): boolean {
  return SANDBOX_CHROME_WHITELIST.has(`${namespace}.${method}`);
}

// ─── Pending run requests ───

const pendingRuns = new Map<string, {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}>();

// ─── Handle messages from sandbox (via offscreen relay) ───

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.type?.startsWith('sandbox:')) return false;

  switch (message.type) {
    case 'sandbox:run_result': {
      const pending = pendingRuns.get(message.id);
      if (pending) {
        clearTimeout(pending.timeoutId);
        pendingRuns.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error));
        } else {
          pending.resolve(message.result);
        }
      }
      return false;
    }

    case 'sandbox:chrome_call': {
      handleChromeCall(message).catch(err => console.error('[sandbox-rpc] chrome_call error:', err));
      return false;
    }

    case 'sandbox:page_exec': {
      handlePageExec(message).catch(err => console.error('[sandbox-rpc] page_exec error:', err));
      return false;
    }
  }

  return false;
});

async function handleChromeCall(msg: {
  id: string; callId: string; namespace: string; method: string; args: unknown[];
}): Promise<void> {
  let result: unknown;
  let error: string | undefined;

  try {
    if (!isChromeCallAllowed(msg.namespace, msg.method)) {
      throw new Error(`Chrome API call not allowed: chrome.${msg.namespace}.${msg.method}`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ns = (chrome as any)[msg.namespace];
    if (!ns) throw new Error(`Unknown chrome namespace: ${msg.namespace}`);

    if (typeof ns[msg.method] !== 'function') {
      throw new Error(`Not a function: chrome.${msg.namespace}.${msg.method}`);
    }

    result = await ns[msg.method](...msg.args);
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

async function handlePageExec(msg: {
  id: string; callId: string; code: string; tabId?: number;
}): Promise<void> {
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

const SANDBOX_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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
    const timeoutId = setTimeout(() => {
      if (pendingRuns.has(id)) {
        pendingRuns.delete(id);
        reject(new Error('Sandbox execution timed out (5 min)'));
      }
    }, SANDBOX_TIMEOUT_MS);

    pendingRuns.set(id, { resolve, reject, timeoutId });
  });

  // Send to offscreen (which relays to sandbox iframe)
  try {
    await chrome.runtime.sendMessage({
      type: 'sandbox:run',
      id,
      code,
      args,
      permissions,
      tabId,
    });
  } catch (err) {
    const pending = pendingRuns.get(id);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingRuns.delete(id);
    }
    throw err;
  }

  return resultPromise;
}

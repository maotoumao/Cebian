/**
 * Chrome extension API wrappers for agent tools.
 * Provides tab ID resolution, script execution with frame support,
 * and navigation waiting.
 */

// ─── Tab ID resolution ───

/**
 * Get the active tab's ID in the current window.
 * Throws if no active tab is found.
 */
export async function getActiveTabId(): Promise<number> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error('No active tab found.');
  return tab.id;
}

/**
 * Resolve a tab ID: use the provided tabId if given, otherwise fall back to the active tab.
 */
export async function resolveTabId(tabId?: number): Promise<number> {
  if (tabId != null) return tabId;
  return getActiveTabId();
}

// ─── Script execution wrappers ───

/**
 * Execute a function in the active tab (or a specific frame) and return its result.
 */
export async function executeInTab<T>(
  tabId: number,
  func: () => T,
  frameId?: number,
): Promise<T> {
  const target = frameId != null
    ? { tabId, frameIds: [frameId] }
    : { tabId };

  const results = await chrome.scripting.executeScript({ target, func } as any);
  return results?.[0]?.result as T;
}

/**
 * Execute a function with serialized arguments in the active tab (or a specific frame).
 */
export async function executeInTabWithArgs<TArgs extends any[], T>(
  tabId: number,
  func: (...args: TArgs) => T,
  args: TArgs,
  frameId?: number,
): Promise<T> {
  const target = frameId != null
    ? { tabId, frameIds: [frameId] }
    : { tabId };

  const results = await chrome.scripting.executeScript({ target, func, args } as any);
  return results?.[0]?.result as T;
}

// ─── CDP debugger execution ───

/**
 * Execute code via CDP Runtime.evaluate (debugger).
 * Used when page CSP blocks new Function() / eval(), or when direct CDP access is needed.
 */
export async function executeViaDebugger(tabId: number, code: string): Promise<string> {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e: any) {
    if (!e.message?.includes('Already attached')) throw e;
  }

  try {
    const expression = `(async () => { ${code} })()`;
    const result = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }) as any;

    if (result.exceptionDetails) {
      const errMsg = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? 'Unknown error';
      return `Error: ${errMsg}`;
    }

    const value = result.result?.value;
    if (value === undefined) return '(no return value)';
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } finally {
    try { await chrome.debugger.detach(target); } catch { /* ignore */ }
  }
}

// ─── Navigation waiting ───

/**
 * Wait for a tab navigation to complete using chrome.tabs.onUpdated.
 * In-page scripts are destroyed on navigation, so this must run in extension context.
 */
export function waitForNavigation(tabId: number, timeout: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (fn: (v: any) => void, value: any) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      settle(reject, new Error(`Navigation timeout: ${timeout}ms`));
    }, timeout);
    const listener = (updatedTabId: number, info: chrome.tabs.OnUpdatedInfo, _tab: chrome.tabs.Tab) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        settle(resolve, 'Navigation complete');
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    // Catch-up: navigation may have completed before listener was attached
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') {
        settle(resolve, 'Navigation complete');
      }
    });
  });
}

/** `navigateAndWait` 里「先见到 loading 再认 complete」的宽限：过了还没见到就接受下一个 complete。 */
const NAVIGATE_LOADING_GRACE_MS = 2_000;

/**
 * 把一个**已有**标签页导航到 `url` 并等这次导航完成。
 *
 * 与 `waitForNavigation` 的区别：那边的 catch-up 分支会把上一页遗留的 `complete` 当成
 * 本次完成——对停在旧结果页上的复用 tab 来说，`tabs.update` 返回时状态还是旧页的
 * `complete`，立刻返回就会读到上一次的内容。这里先挂监听再发起导航，并要求先观察到
 * 本次 `loading`（或 url 变化）才接受 `complete`；万一浏览器把事件合并了，宽限期后退回
 * 接受下一个 `complete`（或此刻已是 complete）。tab 被关掉 / 超时都 reject。
 */
export function navigateAndWait(tabId: number, url: string, timeout: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let sawLoading = false;
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      clearTimeout(grace);
    };
    const settle = (fn: (v: any) => void, value: any) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const timer = setTimeout(() => settle(reject, new Error(`Navigation timeout: ${timeout}ms`)), timeout);
    const grace = setTimeout(() => {
      if (sawLoading) return;
      sawLoading = true;
      chrome.tabs.get(tabId).then(
        (tab) => { if (tab.status === 'complete') settle(resolve, undefined); },
        (e) => settle(reject, e),
      );
    }, NAVIGATE_LOADING_GRACE_MS);
    const onUpdated = (updatedTabId: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (updatedTabId !== tabId) return;
      if (info.status === 'loading' || info.url !== undefined) sawLoading = true;
      if (info.status === 'complete' && sawLoading) settle(resolve, undefined);
    };
    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) settle(reject, new Error('Tab was closed during navigation'));
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    chrome.tabs.update(tabId, { url }).catch((e) => settle(reject, e));
  });
}

// ─── Page injectability ───

import { RESTRICTED_URL_PREFIXES } from '@/lib/recorder/constants';

/**
 * Whether a content script can be programmatically injected into a page.
 *
 * Pages served from `chrome://`, `chrome-extension://`, `edge://`, `about:`,
 * and the Chrome Web Store reject `chrome.scripting.executeScript`. The
 * recorder uses this to silently skip interaction/mutation capture on those
 * pages while still recording tab/navigation events.
 *
 * Returns `false` for `undefined` / empty / non-`http(s)` URLs as a
 * conservative default — anything we don't recognize as a normal web page
 * is treated as restricted.
 */
export function isInjectablePage(url: string | undefined): boolean {
  if (!url) return false;
  for (const prefix of RESTRICTED_URL_PREFIXES) {
    if (url.startsWith(prefix)) return false;
  }
  // Must be http(s); file://, ws://, data:, blob:, javascript: etc. are
  // either non-injectable or don't make sense for a user-action recorder.
  return url.startsWith('http://') || url.startsWith('https://');
}

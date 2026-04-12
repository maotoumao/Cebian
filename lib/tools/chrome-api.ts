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

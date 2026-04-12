/**
 * Shared utilities for agent tools.
 * Provides tab ID resolution, script execution wrappers with frame support,
 * and navigation waiting.
 */

// ─── Injection target builder ───

function buildTarget(tabId: number, frameId?: number): chrome.scripting.InjectionTarget {
  const target: chrome.scripting.InjectionTarget = { tabId };
  if (frameId) target.frameIds = [frameId];
  return target;
}

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
 * Wraps chrome.scripting.executeScript with error handling.
 */
export async function executeInTab<T>(
  tabId: number,
  func: () => T,
  frameId?: number,
): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: buildTarget(tabId, frameId),
    func,
  });
  const result = results?.[0];
  if (result?.error) {
    throw new Error(result.error.message ?? 'Script execution failed.');
  }
  return result?.result as T;
}

/**
 * Execute a function with serialized arguments in the active tab (or a specific frame).
 * Use when you need to pass parameters into the injected function.
 */
export async function executeInTabWithArgs<TArgs extends any[], T>(
  tabId: number,
  func: (...args: TArgs) => T,
  args: TArgs,
  frameId?: number,
): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: buildTarget(tabId, frameId),
    func,
    args,
  });
  const result = results?.[0];
  if (result?.error) {
    throw new Error(result.error.message ?? 'Script execution failed.');
  }
  return result?.result as T;
}

// ─── Navigation waiting ───

/**
 * Wait for a tab navigation to complete using chrome.tabs.onUpdated.
 * Used by interact tool's wait_navigation action.
 * In-page scripts are destroyed on navigation, so this must run in extension context.
 */
export function waitForNavigation(tabId: number, timeout: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Navigation timeout: ${timeout}ms`));
    }, timeout);
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve('Navigation complete');
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

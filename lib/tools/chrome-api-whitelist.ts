/**
 * Shared Chrome API whitelist and validation.
 * Single source of truth for which chrome.* methods are allowed.
 * Used by both chrome_api tool (LLM direct calls) and sandbox RPC (skill scripts).
 */

// ─── Whitelist: allowed chrome.* API calls ───
// Only APIs whose permission is declared in manifest are included.
// To add new namespaces, also add the permission in wxt.config.ts.

// 用 `satisfies` 而非显式标注，保留字面量 key 联合（`'tabs' | 'cookies' | ...`），
// 让 `keyof typeof CHROME_API_WHITELIST` 能驱动其它映射的穷尽检查（见
// `lib/agent/tool-permissions.ts` 的 CHROME_NS_I18N）。
export const CHROME_API_WHITELIST = {
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
} satisfies Record<string, Set<string>>;

/** Parts that must never appear in method paths (prototype pollution guard) */
const FORBIDDEN_PATH_PARTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Check if a chrome API call is allowed.
 * Blocks prototype pollution attempts and enforces flat method names.
 */
export function isChromeCallAllowed(namespace: string, method: string): boolean {
  // Block prototype pollution
  if (FORBIDDEN_PATH_PARTS.has(namespace) || FORBIDDEN_PATH_PARTS.has(method)) return false;

  // Flat method names only (no dots for non-help namespaces)
  if (method.includes('.')) return false;

  // own-property 守卫：namespace 是任意 string，没有这层 `toString` / `valueOf`
  // 这类继承名会取到 Object.prototype 上的函数，后续 `.has` 直接抛错。守卫后再
  // 用字面量 key 索引（satisfies 保留的字面量 key 联合）。
  if (!Object.prototype.hasOwnProperty.call(CHROME_API_WHITELIST, namespace)) return false;
  return CHROME_API_WHITELIST[namespace as keyof typeof CHROME_API_WHITELIST].has(method);
}

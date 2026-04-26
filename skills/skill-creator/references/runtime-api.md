# Skill script runtime (sandbox + chrome.* + executeInPage)

How a skill's `scripts/*.js` runs when invoked via the `run_skill` tool. Read this whenever you author or debug a skill that ships scripts.

## Execution environment

Skill scripts run inside a sandboxed iframe page that is bundled with the extension. They do **not** run in the page being inspected, and they do **not** run in the extension service worker. Sensitive operations (`chrome.*`, page injection) are RPC'd over `postMessage` to the background, which enforces a whitelist.

Consequences:

- No DOM, no `document`, no `window` of the inspected page.
- No `localStorage`, `sessionStorage`, `IndexedDB`, `WebSocket`, `XMLHttpRequest`, `Worker`.
- No direct access to extension APIs (`chrome.runtime.*`, `chrome.scripting.*`, `chrome.storage.*`).
- Cookies: top-level `fetch` from the sandbox does **not** carry any site cookies (the sandbox iframe has its own opaque origin). To act with the user's identity on a site, either inject via `executeInPage` (runs in the page's main world, carries cookies) or read cookies explicitly via `chrome.cookies` (declare the permission). See [injection-patterns.md](injection-patterns.md).

## Always-available globals

These are present in every skill script regardless of `metadata.permissions`:

| Global | Notes |
|---|---|
| `fetch` | Standard `fetch`. **No site cookies** (sandbox origin). |
| `JSON` | Standard. |
| `console` | Logs to the sandbox iframe's devtools, not the page or service worker. |
| `crypto` | Standard Web Crypto. |
| `TextEncoder`, `TextDecoder` | Standard. |
| `URL`, `URLSearchParams` | Standard. |
| `atob`, `btoa` | Standard base64. |
| `setTimeout`, `clearTimeout` | Standard. **No `setInterval`** — use `setTimeout` recursion if needed. |
| `AbortController` | Standard, useful for cancellable `fetch`. |
| `args` | The arguments object passed by the agent in the `run_skill` call. |
| `module` | CommonJS-style export holder; assign `module.exports = value` to set the script's return value (see "Returning a value"). |

Anything outside this list is undefined. There is no `require`, no `import`, no `setInterval`, no DOM globals.

## Script structure

A script is a complete JavaScript file. It is wrapped in `async () => { ... }` and executed once. Use `await` freely.

```js
// scripts/example.js
const data = await fetch('https://api.example.com/x').then(r => r.json());
module.exports = { count: data.length };
```

### Returning a value

The script's return value is whatever `module.exports` was set to when the wrapped async function settles. The sandbox JSON-clones it (`JSON.parse(JSON.stringify(result))`) and `run_skill` then re-stringifies the result with 2-space indent before delivering it to the agent as a text string — the agent never sees a structured value.

- If `module.exports` is JSON-serializable, the agent receives an equivalent pretty-printed JSON text.
- Non-JSON values (`Date`, `Map`, `Set`, typed arrays, ...) are coerced or dropped silently by `JSON.stringify`. `BigInt` triggers the fallback below.
- If `JSON.stringify` throws, the sandbox falls back to `String(result)`.
- If `module.exports` was never assigned (or set to `undefined`), the agent receives the literal string `(no return value)`.

A bare `return` at the top of the script does nothing useful — the wrapper consumes it. Always set `module.exports`.

### Receiving arguments

The agent passes a JSON object via the `args` parameter of `run_skill`. The script reads it via the `args` global:

```js
// run_skill called with: args: { folderId: "12345", limit: 50 }
const items = await chrome.bookmarks.getChildren(args.folderId);
module.exports = items.slice(0, args.limit);
```

## Declaring `metadata.permissions`

Permissions live in `SKILL.md` frontmatter:

```yaml
metadata:
  permissions:
    - chrome.bookmarks
    - chrome.tabs
    - page.executeJs
```

Each entry is one of:

- **`chrome.<namespace>`** — exposes `chrome.<namespace>.<method>(...)` for whitelisted methods only (see table below). Calls return `Promise`s.
- **`page.executeJs`** — exposes the global `executeInPage(code)` async function for injecting JS into a tab.

Anything else (e.g. `chrome.storage`, `chrome.scripting`, plain `executeJs`) is silently ignored — the corresponding global will not appear and calls will fail with `undefined is not a function`.

If `metadata.permissions` is omitted or empty, the script can still use the always-available globals (including `fetch`), but `chrome` and `executeInPage` will be undefined.

## `chrome.*` whitelist

Only these namespaces and methods are callable from skill scripts. Everything else returns `undefined`. The list is the source of truth at the time of writing; if you need a method that is missing, either negotiate with the user to extend the whitelist in the extension code, or fall back to `executeInPage` for page-side equivalents.

| Namespace | Methods |
|---|---|
| `chrome.tabs` | `query`, `get`, `create`, `update`, `remove`, `reload`, `captureVisibleTab`, `duplicate`, `move`, `group`, `ungroup` |
| `chrome.windows` | `getAll`, `get`, `create`, `update`, `remove`, `getCurrent`, `getLastFocused` |
| `chrome.alarms` | `get`, `getAll`, `create`, `clear`, `clearAll` |
| `chrome.webNavigation` | `getFrame`, `getAllFrames` |
| `chrome.bookmarks` | `getTree`, `getChildren`, `get`, `search`, `create`, `update`, `remove`, `move` |
| `chrome.history` | `search`, `getVisits`, `addUrl`, `deleteUrl`, `deleteRange` |
| `chrome.cookies` | `get`, `getAll`, `set`, `remove`, `getAllCookieStores` |
| `chrome.topSites` | `get` |
| `chrome.sessions` | `getRecentlyClosed`, `getDevices`, `restore` |
| `chrome.downloads` | `search`, `pause`, `resume`, `cancel`, `download` |
| `chrome.notifications` | `create`, `update`, `clear`, `getAll`, `getPermissionLevel` |

All calls return Promises. Method paths with dots (e.g. `chrome.tabs.foo.bar`) are rejected; only flat method names work.

## `executeInPage(code)`

When `page.executeJs` is declared, the global `executeInPage` is available:

```js
const title = await executeInPage(`return document.title`);
```

Behavior:

- Signature: `executeInPage(code: string): Promise<string>`.
- The `code` string is wrapped in `async () => { CODE }` — write `return` directly to produce a result; do NOT wrap in your own IIFE.
- Runs in the **target tab's main world** via Chrome DevTools Protocol (the same mechanism the agent's `execute_js` tool falls back to). The browser displays a "this tab is being debugged" banner while a script is in flight.
- The `tabId` is the one the agent passed to `run_skill` (`tabId` parameter). The script cannot pick a different tab.
- The return value is **always a string**:
  - String values are returned as-is.
  - Non-string values are `JSON.stringify`-ed with 2-space indent.
  - Exceptions inside the page are returned as `Error: <message>`.
  - `undefined` returns the literal string `(no return value)`.
- Because the code runs in the page's main world, `fetch` inside it carries the page's cookies and is subject to the page's CORS, but bypasses the page's CSP for `eval`/`new Function` (CDP-injected code is exempt). Be aware of the security implications.

## User permission flow

The first time `run_skill` is asked to run a script for a skill that declares any `metadata.permissions`, it does NOT execute. Instead:

1. `run_skill` returns a `permission_required` result containing a one-time `confirmation_nonce` (5-minute TTL) and the list of requested permissions.
2. The agent must call `ask_user` with three options in the user's language: equivalents of "Deny", "Allow once", "Always allow this skill".
3. If the user picks "Allow once" or "Always allow", the agent re-invokes `run_skill` with the same `skill` / `script` / `args` / `tabId` plus `confirmation_nonce`. For "Always allow", also pass `always_allow: true`.
4. With a valid nonce the script runs. With `always_allow: true`, the grant is persisted in `chrome.storage.local` under `skillGrants[<skillName>]`.
5. The grant is keyed to the exact permission set. If the skill is later edited to declare a different permission set (added or removed), the next call re-prompts.
6. Nonces are single-use and expire after 5 minutes; the agent cannot fabricate one.

Skills with no `metadata.permissions` skip this flow entirely.

## Errors

- Calling a method outside the whitelist for a permitted namespace (e.g. `chrome.tabs.foo()` when `tabs` is allowed but `foo` is not): the call returns a `Promise` that rejects with an error from the background — it is **not** a synchronous `TypeError`. `await` it inside `try/catch`.
- Calling a namespace not declared in `metadata.permissions`: `chrome.<that-namespace>` is `undefined`, so the call throws a synchronous `TypeError: undefined is not an object` (or similar).
- Calling `executeInPage` without `page.executeJs`: `executeInPage` is `undefined`, same synchronous TypeError.
- Page-side exceptions inside `executeInPage`: returned as the string `Error: <message>` (not thrown).
- Sandbox-side exceptions: thrown out of the script, surfaced to the agent as `Script execution error: <message>`.

## Examples

### Pure `chrome.*`, no page interaction

`SKILL.md` frontmatter:

```yaml
metadata:
  permissions:
    - chrome.bookmarks
```

`scripts/list-bookmarks.js`:

```js
const all = await chrome.bookmarks.search({ query: args.query ?? '' });
module.exports = all.slice(0, args.limit ?? 20).map(b => ({
  title: b.title,
  url: b.url,
}));
```

### Mixed: read page state, then act with chrome.*

`SKILL.md` frontmatter:

```yaml
metadata:
  permissions:
    - chrome.bookmarks
    - page.executeJs
```

`scripts/save-page.js`:

```js
const titleJson = await executeInPage(`return document.title`);
const urlJson = await executeInPage(`return location.href`);
// executeInPage returns strings — but `document.title` already is a string,
// so it round-trips cleanly.
await chrome.bookmarks.create({
  parentId: args.folderId,
  title: titleJson,
  url: urlJson,
});
module.exports = { saved: true, title: titleJson, url: urlJson };
```

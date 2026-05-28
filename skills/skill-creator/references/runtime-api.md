# Skill script runtime (sandbox + chrome.* + executeInPage)

How a skill's `scripts/*.js` runs when invoked via the `run_skill` tool. Read this whenever you author or debug a skill that ships scripts.

## Execution environment

Skill scripts run inside a sandboxed iframe page that is bundled with the extension. They do **not** run in the page being inspected, and they do **not** run in the extension service worker. Sensitive operations (`chrome.*`, page injection) are RPC'd over `postMessage` to the background, which enforces a whitelist.

Consequences:

- No DOM, no `document`, no `window` of the inspected page.
- No `localStorage`, `sessionStorage`, `IndexedDB`, `WebSocket`, `XMLHttpRequest`, `Worker`.
- No direct access to extension APIs (`chrome.runtime.*`, `chrome.scripting.*`, `chrome.storage.*`).
- **Network**: top-level `fetch` runs from the sandbox iframe's **opaque origin** and is subject to standard CORS — the extension's `host_permissions: <all_urls>` does **not** apply to sandbox pages. Practically: anonymous public APIs that send `Access-Control-Allow-Origin: *` (some open data feeds, public CDNs) work; Azure OpenAI, OpenAI, GitHub's authenticated endpoints, most private backends, and anything else that doesn't volunteer permissive CORS headers will fail. To call those APIs reliably, declare the `bgFetch` permission and use the `bgFetch(url, init)` global — it runs in the background service worker where `host_permissions` does apply, completely bypassing CORS.
- **Cookies**: top-level `fetch` from the sandbox does **not** carry any site cookies (opaque origin). `bgFetch` also runs without site cookies (SW context). To act with the user's identity on a website, either inject via `executeInPage` (page main world, carries cookies) or read cookies explicitly via `chrome.cookies` (declare the permission). See [injection-patterns.md](injection-patterns.md).

## Always-available globals

These are present in every skill script regardless of `metadata.permissions`:

| Global | Notes |
|---|---|
| `fetch` | Standard `fetch`. **Subject to CORS** (sandbox iframe origin is opaque; `host_permissions` does NOT apply). For arbitrary HTTPS APIs use the `bgFetch` permission instead — see below. No site cookies regardless. |
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
    - bgFetch:https://api.example.com/*
    - vfs.write
```

Each entry is one of:

- **`chrome.<namespace>`** — exposes `chrome.<namespace>.<method>(...)` for whitelisted methods only (see table below). Calls return `Promise`s.
- **`page.executeJs`** — exposes the global `executeInPage(code)` async function for injecting JS into a tab.
- **`bgFetch`** or **`bgFetch:<match-pattern>`** — exposes the `bgFetch(url, init?)` global, a fetch-like helper that runs in the background service worker (bypasses CORS). Bare `bgFetch` allows any http(s) URL (`*://*/*`); add a match-pattern to scope to specific hosts. Multiple `bgFetch:` lines OR together. See the bgFetch section below.
- **`vfs.read`** / **`vfs.write`** — exposes the `vfs` global with file methods scoped to `/workspaces/<sessionId>/<skill>/`. `vfs.write` automatically implies the read methods (no separate `vfs.read` needed when you also write). See the vfs section below.

Failure modes for misdeclared permissions:

- An **unknown permission string** (typo like `page.executejs`, `bgfetch` lowercase, `vfs` without `.read`/`.write`, etc.) is silently dropped — the corresponding global never appears and skill calls throw a synchronous `TypeError: bgFetch is not a function` (or similar).
- A **`chrome.<unsupported-namespace>`** declaration (e.g. `chrome.storage`) DOES expose `chrome.<that-ns>` in the sandbox proxy, but every method call rejects asynchronously with `Chrome API call not allowed: chrome.<ns>.<method>`. The fix is to drop the permission — the namespace will never become callable.
- Always-available globals (`fetch`, `JSON`, `crypto`, `args`, etc.) are unaffected by whether `metadata.permissions` is declared. The CORS-limited sandbox `fetch` is always there.

**Minimum-privilege principle**: declare only what the script actually calls. Each unused permission widens the trust prompt the user sees, training them to dismiss permission prompts mindlessly.

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

## `bgFetch(url, init?)`

When any `bgFetch` or `bgFetch:<match-pattern>` permission is declared, the global `bgFetch` is available:

```js
const resp = await bgFetch('https://api.example.com/v1/items', {
  method: 'POST',
  headers: { 'authorization': 'Bearer ...', 'content-type': 'application/json' },
  body: JSON.stringify({ q: args.query }),
});
if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
const data = await resp.json();
```

`bgFetch` runs the request from the **background service worker**, which holds the extension's `<all_urls>` host_permissions and therefore bypasses CORS entirely. Use it for any third-party HTTPS API the skill calls — Azure OpenAI, OpenAI, GitHub REST API, private backends, anything that doesn't volunteer permissive CORS headers for a sandbox iframe.

### Why `bgFetch` and not page-side `executeInPage`?

A common but wrong instinct is "the user is on the API's web app, so I'll call the API from `executeInPage` to dodge CORS". Three reasons not to:

1. **Page scripts can intercept your request.** Anything on that tab — analytics, third-party widgets, the app itself — can monkey-patch `fetch` and capture your headers (including the API key).
2. **It only works when the user happens to be on a same-origin page.** Switch tabs → skill breaks.
3. **The credentials end up wherever the page sends them.** Page-side error reporting often ships request payloads to the page's own logging service.

`bgFetch` runs in an isolated SW context with no third-party scripts. The API key never leaves the extension's address space.

### Interface

`bgFetch(url: string, init?: BgFetchInit): Promise<BgFetchResponse>`

`init` is a subset of `RequestInit`:

| Field | Type | Notes |
|---|---|---|
| `method` | `string` | Defaults to `'GET'`. |
| `headers` | `Record<string, string>` or `Headers` | Sandbox-side `Headers` instances are flattened before being sent. |
| `body` | `string`, `Uint8Array`, `ArrayBuffer`, `ArrayBufferView` | `Blob` / `File` is **not** supported (the RPC boundary is JSON-only) — convert via `new Uint8Array(await blob.arrayBuffer())` first. |
| `redirect` | `'follow' \| 'error' \| 'manual'` | Mirrors native fetch. |
| `referrer`, `referrerPolicy`, `cache` | Standard | Pass through to the SW fetch. |

Not supported: `mode`, `credentials` (SW context has no site cookies anyway), `signal` (cancellation is automatic when the `run_skill` timeout fires or the sandbox is torn down), `integrity`, `keepalive`, `priority`. There is no manual cancellation surface for the skill author in v1.

The returned `BgFetchResponse` mirrors the native `Response` interface as closely as possible:

| Property / method | Notes |
|---|---|
| `status`, `statusText` | Standard. |
| `ok` | `status >= 200 && status < 300`. |
| `redirected` | Whether the response followed at least one redirect. |
| `url` | Final URL after redirects. |
| `headers` | Real `Headers` instance — use `.get(name)`, `.has(name)`, `.forEach(...)`. |
| `text()` | Decoded with UTF-8. |
| `json()` | `JSON.parse(text())`. |
| `arrayBuffer()` | Fresh copy of the body bytes. |
| `bytes()` | `Uint8Array` view (no copy). |
| `blob()` | `Blob` with `Content-Type` from response headers. |

The body is already buffered (not streamed), so any of the reader methods can be called multiple times — there's no `bodyUsed` consume-once semantics.

### Match-pattern syntax

The optional `:<pattern>` after `bgFetch` follows Chrome's [match-pattern](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns) syntax:

| Pattern | Allowed URLs |
|---|---|
| `bgFetch` | Any http(s) URL (same as `*://*/*`). |
| `bgFetch:https://api.example.com/*` | Only that exact host. |
| `bgFetch:https://*.example.com/*` | That domain and any subdomain. |
| `bgFetch:*://api.example.com/*` | Either http or https. |
| `bgFetch:<all_urls>` | Same as `bgFetch`. |

Pattern parts cover **scheme + host + pathname only** — do NOT put query strings or fragments in a pattern. Matching ignores `?query` and `#fragment` in the actual URL, and a pattern like `bgFetch:https://api.example.com/foo?api-version=*` parses but will never match. Use a path-only glob (e.g. `https://api.example.com/foo*` or `https://api.example.com/*`) and let the URL's query string ride along unrestricted.

Schemes other than `http` / `https` / `*` are rejected when the pattern is parsed. Patterns are parsed once at run setup, **before the script's first `bgFetch` call**, so malformed patterns surface immediately on the first `run_skill` (after the user grants permission), not silently at first call. Prefer the narrowest pattern that covers your real call set — declared scope is what the user sees on the permission prompt.

### Error model

`bgFetch` matches native `fetch` semantics:

- Network errors (DNS, TCP, TLS, aborted) → `throw`.
- HTTP responses (including 4xx / 5xx) → resolved `BgFetchResponse` with `ok=false`. The skill checks `resp.ok` or `resp.status` and reacts accordingly.
- URL not in any declared pattern → `throw`. Add the pattern, or use the agent's existing `fs_save_url` tool for ad-hoc fetches.
- Response body larger than 50 MB → `throw`. The cap exists to protect the SW from OOM. Skip the skill route entirely for very large downloads (use `fs_save_url` which streams to VFS).

## `vfs.*`

When `vfs.read` or `vfs.write` is declared, the `vfs` global is available with a `fs/promises`-like API:

```js
await vfs.writeFile('result.json', JSON.stringify(data));
const back = await vfs.readFile('result.json', 'utf8');
const listing = await vfs.readdir('.');
```

All paths are **relative** to the skill's per-session workspace at `/workspaces/<sessionId>/<skillName>/`. The absolute root is also exposed as the read-only string `vfs.cwd` for constructing markdown links (see Inline images below).

### Scope and lifecycle

- The skill **cannot** write outside its own workspace folder. Absolute paths (`/foo`), `~`-prefixed paths, and any `..` segment that would escape the root are rejected at the path-resolution layer.
- Workspace folders live at `/workspaces/<sessionId>/<skillName>/` and are cleared automatically when the session is deleted — no manual cleanup needed.
- This is **per-session**, not cross-session persistence. Each new chat session starts with an empty workspace. If you need a long-lived cache across sessions, declare nothing here and have the agent maintain state elsewhere; cross-session skill state is not in v1.

### Permissions

| Declared | Methods allowed |
|---|---|
| `vfs.read` only | `readFile`, `readdir`, `stat`, `exists` |
| `vfs.write` only | All of the above **plus** `writeFile`, `mkdir`, `unlink` |

`vfs.write` automatically implies the read methods on the same scope — the `.data` subdirectory is already the privacy boundary, withholding introspection of the skill's own output gives no security gain. Declare only `vfs.write` when the skill both produces and inspects its own files.

### Methods

| Method | Notes |
|---|---|
| `readFile(rel, 'utf8')` | UTF-8 string. Without the encoding argument, returns a `Uint8Array`. |
| `readFile(rel, { encoding: 'utf8' })` | Node `fs.promises` object form is also accepted. |
| `writeFile(rel, data, opts?)` | `data` is `string \| Uint8Array \| ArrayBuffer`. Parent directories are auto-created. `Blob` is **not** accepted — convert first. |
| `mkdir(rel, opts?)` | Defaults to `{ recursive: true }` (no EEXIST). Pass `{ recursive: false }` to detect existing dirs. |
| `readdir(rel)` | Returns `string[]` of entry names. |
| `stat(rel)` | Returns `{ size, mtimeMs, isFile, isDirectory }` — note `isFile` / `isDirectory` are **booleans**, not methods (unlike Node `fs.Stats`). |
| `exists(rel)` | Boolean. |
| `unlink(rel)` | Delete a file. No recursive delete in v1 — call `unlink` on each leaf if you need to. |

### Inline images in the agent's response

The chat markdown renderer recognizes any image whose `src` matches `#/workspaces/<...>` (or `#/home/<...>`) and resolves it against the VFS at render time. This means a skill can produce a binary file and return a small markdown link, and the user sees the image directly in the chat bubble — no base64 in the agent's context:

```js
const resp = await bgFetch('https://images.example.com/render?q=cat');
const bytes = await resp.bytes();
const filename = `out-${Date.now()}.png`;
await vfs.writeFile(filename, bytes);
module.exports = `![cat](#${vfs.cwd}/${filename})`;
```

The renderer handles loading state, broken paths (red warning card), unsupported MIME types, and files larger than 30 MB (falls back to a "open in VFS browser" link). Use this pattern instead of base64-encoding binary into the return value.

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
- Calling a namespace not declared in `metadata.permissions`: `chrome.<that-namespace>` is `undefined`, so the call throws a synchronous `TypeError: undefined is not an object` (or similar). Same for `executeInPage`, `bgFetch`, `vfs` when their permission is missing.
- Page-side exceptions inside `executeInPage`: returned as the string `Error: <message>` (not thrown).
- `bgFetch` URL doesn't match any declared pattern: the returned Promise rejects with `URL "..." not allowed by bgFetch patterns. Declared: ...`. `await` inside `try/catch` to handle.
- `bgFetch` network error / AbortError: rejected Promise, same as native `fetch`. HTTP 4xx/5xx do **not** reject — inspect `resp.ok` / `resp.status`.
- `vfs` path traversal attempt (`../escape`, `/abs/path`, `~/foo`): the returned Promise rejects with `vfs path ... escapes skill workspace` or `... must be relative to skill workspace`. `await` inside `try/catch` to handle.
- `vfs.writeFile` with an unsupported data type (e.g. `Blob`): rejected Promise with an actionable message naming the conversion to do (`new Uint8Array(await blob.arrayBuffer())`).
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

### Third-party HTTPS API → inline image

The canonical "skill calls an LLM / image / generation API and shows the result in chat" pattern. Combines `bgFetch` (bypasses CORS, keeps the API key out of the agent's context) with `vfs.write` (large binary stays out of the agent's context) and the renderer's inline VFS image support (user sees the result directly in the chat bubble).

`SKILL.md` frontmatter:

```yaml
metadata:
  permissions:
    - bgFetch:https://api.example.com/*
    - vfs.write
```

`scripts/generate.js`:

```js
// API_KEY lives in the script file; the agent never reads this content,
// so the key never enters the conversation log.
const API_KEY = 'sk-...';
const ENDPOINT = 'https://api.example.com/v1/images/generate';

const resp = await bgFetch(ENDPOINT, {
  method: 'POST',
  headers: {
    'authorization': `Bearer ${API_KEY}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    prompt: args.prompt,
    size: args.size ?? '1024x1024',
  }),
});
if (!resp.ok) {
  throw new Error(`API HTTP ${resp.status}: ${await resp.text()}`);
}
const json = await resp.json();

// Response shape depends on the API; assume base64-in-JSON for this example.
const bytes = Uint8Array.from(atob(json.data[0].b64), c => c.charCodeAt(0));
const filename = `${Date.now()}.png`;
await vfs.writeFile(filename, bytes);

// Return a structured object so the agent extracts the markdown rather
// than relaying a JSON-encoded string with quotes. The SKILL.md body
// instructs the agent to render the `markdown` field as markdown.
const path = `${vfs.cwd}/${filename}`;
module.exports = {
  markdown: `![generated image](#${path})`,
  path,
};
```

Total tokens added to the agent's context: about 80, regardless of the image size. Use a fixed alt text — `args.prompt` could contain characters (`]`, newlines) that break the markdown syntax.

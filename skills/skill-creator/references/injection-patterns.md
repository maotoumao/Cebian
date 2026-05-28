# Injection patterns: when to ship a skill, when to use a tool

Cebian gives the agent several ways to run code: directly via the `execute_js` tool on the user's current page, or — inside a skill — across four different execution surfaces. This reference helps you pick the right one (and helps you avoid the four common traps in the **Anti-patterns** section near the end).

## Choose where to run code

| Mechanism | Where it runs | Who invokes it | Persists across sessions |
|---|---|---|---|
| `execute_js` tool | Target tab's main world | Agent, ad hoc | No — agent re-derives the code each time |
| `executeInPage(code)` (skill) | Target tab's main world | Skill script via `run_skill` | Yes — code lives in the skill repo |
| `chrome.<ns>.<method>(...)` (skill) | Sandbox iframe, RPC'd to background | Skill script via `run_skill` | Yes — same |
| `bgFetch(url, init?)` (skill) | Background service worker | Skill script via `run_skill` | Yes — same |

`execute_js` and `executeInPage` are the same underlying capability with different *origin of code* and *user-trust* envelopes. `chrome.*` and `bgFetch` are separate channels that never touch the inspected page.

### Decision matrix

| You want to... | Use |
|---|---|
| Run a one-off snippet the agent will write fresh per task | `execute_js` (no skill needed) |
| Read or manipulate the user's currently visible page DOM | A skill with `metadata.permissions: [page.executeJs]` |
| Act with the user's logged-in session on a website (post, scrape, save via that site's own API) | `page.executeJs` (page main world, carries cookies) |
| Call a third-party HTTPS API with an API key the skill owns | A skill with `metadata.permissions: [bgFetch:<pattern>]`. **Do not** route this through `executeInPage` — see Anti-pattern #1. |
| Read browser-state APIs (bookmarks, history, cookies, downloads, ...) without touching any page | A skill with `metadata.permissions: [chrome.<...>]` only — omit `page.executeJs` |
| Bypass a strict page CSP (`unsafe-eval` blocked) | Either `execute_js` or `executeInPage`; both fall back to / use CDP `Runtime.evaluate` |
| Persist large skill output the user should see | `vfs.write` + a markdown link to `#${vfs.cwd}/...` — see "Choose where to put results" below |
| Maintain user trust over many sessions | A skill — the user grants permission once, can revoke anytime |
| Avoid the "Cebian started debugging this browser" banner that CDP triggers | Use `chrome.*` / `bgFetch` / `vfs.*` and stay out of `executeInPage` / `execute_js` |

If a script declares a permission but never uses the corresponding global, drop the permission. Declared-but-unused permissions train users to dismiss prompts.

## Cookie / origin matrix (security & correctness)

`fetch` behaves very differently depending on where it runs:

| Caller | Origin of `fetch` | Sends cookies for the target site? | CORS applies? |
|---|---|---|---|
| `execute_js` tool | Page's main world (`location.origin`) | **Yes** — same-origin requests carry the user's session cookies, including HttpOnly. Cross-origin requests follow normal CORS + `credentials` rules. | Yes (same as native fetch from that page). |
| `executeInPage(code)` from a skill | Page's main world (same as above) | **Yes** — identical behavior. | Yes. |
| Top-level `fetch` in a skill script (sandbox) | Opaque sandbox origin | **No** — never carries any site cookies. | **Yes** — sandbox iframes do not inherit `host_permissions`, so any cross-origin call must be allowed by the server's CORS headers. Practically: most authenticated / private APIs fail here. Use `bgFetch` instead. |
| `bgFetch(url)` from a skill | Background service worker | **No** — SW has no site cookies. | **No** — SW holds `<all_urls>` host_permissions, so cross-origin works without CORS. |
| `chrome.cookies.get/getAll(...)` from a skill | Background, with `cookies` host permission | **Yes (read)** — can read any cookie for any matched origin, including HttpOnly. Use deliberately. | N/A — this is a cookie read, not a fetch. |

Implications:

- "Act as the user on a website" (post a comment, scrape a logged-in page) → `executeInPage` (carries cookies) or a deliberate `chrome.cookies` + `bgFetch` flow if you need to combine the user's session with cross-origin calls.
- "Call a public or API-key-authenticated third-party API" → `bgFetch`. The SW context bypasses CORS, isolates from page scripts, and keeps the API key away from page-side observers.
- Reading session cookies is a powerful capability. Be explicit in the skill `description` and `metadata.permissions` so the user understands what they are granting.

## CSP and CDP

Both `execute_js` and `executeInPage` ultimately can reach the page via Chrome DevTools Protocol (`Runtime.evaluate`):

- `execute_js` first tries `chrome.scripting.executeScript({ world: 'MAIN' })`. If the page CSP blocks `eval`/`new Function`, it falls back to CDP automatically.
- `executeInPage` always goes through CDP via the `debugger` permission.

CDP-injected code bypasses the page's CSP for `eval`/`new Function`. While any CDP call is in flight, Chrome shows a "Cebian started debugging this browser" banner on the affected tab. The banner is the user's only visible signal that the extension is touching the page — do not try to suppress or downplay it in skill instructions.

## Code-string conventions

Both `execute_js` and `executeInPage` wrap your `code` string as the body of `async () => { CODE }`. Two consequences:

- Use bare `return` to produce a value: `executeInPage('return document.title')`. Top-level `await` is allowed.
- Do **not** wrap your code in an IIFE like `(() => { return x })()` — the outer async function has no top-level `return`, so the result comes back as `(no return value)`. Use a bare top-level `return x` instead.
- The return value is rendered as text: strings pass through as-is, non-strings are `JSON.stringify`-ed with 2-space indent, and `undefined` (or no top-level `return`) becomes the literal `(no return value)`.
- Errors surface differently per path. An exception in `execute_js`'s MAIN-world path causes `chrome.scripting.executeScript` to reject and the tool call to fail outright. On the CSP-fallback path of `execute_js`, and inside `executeInPage` (always CSP), exceptions are returned in-band as a string starting with `Error: <message>` instead.

## Choose where to put results

Where the script's output goes is as important as where the code runs. The cost of "agent context" is in tokens, latency, and provider logs.

| Size / shape of result | Put it where |
|---|---|
| Small structured data (counts, metadata, summary) | `module.exports = value` — agent receives it as pretty-printed JSON text. |
| Short markdown the user should see (titles, summaries, status messages) | `module.exports = "..."` — agent renders it in the reply. |
| Binary artifact (image, audio, PDF, generated file) | Declare `vfs.write`, `vfs.writeFile('out.png', bytes)`, return a short markdown link. The chat renderer inlines images automatically when their `src` matches `#/workspaces/<...>` or `#/home/<...>`. |
| Large text (full-page extract, generated report, structured dump) | Either `vfs.write` from the skill (return path), **or** have the agent call `execute_js` with `outputPath` / `fs_save_url` with `dest` directly, bypassing `run_skill` entirely. |
| Anything > ~1 KB | Strongly prefer VFS — every byte of `module.exports` becomes agent context tokens. |

**The 80-byte test**: aim for the skill's `module.exports` to be under ~80 characters when the workflow produces media or large data. A skill that does its job and then `module.exports`-es 150 KB back to the agent is wasting tokens on every invocation.

`executeInPage` (inside a skill script) has **no equivalent shortcut** to write VFS directly — its return value travels through the skill script's Promise. If a workflow's natural payload is a large page-side extraction, the right answer is usually to call the agent's `execute_js` tool directly with `outputPath`, then have the skill operate on the smaller distilled data.

## Anti-patterns

These four traps repeatedly catch first-time skill authors. Recognize them.

### 1. Using `executeInPage` to call a third-party HTTPS API

A common but wrong instinct: "the API has a web app the user is on, so I'll fetch from `executeInPage` to dodge CORS". This is the **least safe** of the four execution surfaces:

- Any script on that page can monkey-patch `fetch` / `XMLHttpRequest` and capture the request — **including your API key in the headers**.
- The page's CSP and analytics may exfiltrate request payloads to its own logging.
- It only works while the user happens to be on a same-origin page. They switch tabs → skill breaks.

Use `bgFetch:<pattern>` instead. The request runs in the background SW, isolated from any page, with the extension's `host_permissions` granting CORS-free access. The API key never leaves the extension's address space.

### 2. Returning binary data via `module.exports`

```js
// ❌ BAD
const bytes = await someApi();
const b64 = btoa(String.fromCharCode(...bytes));
module.exports = { image: b64 };  // 150 KB into the agent's context!
```

Every byte becomes tokens. A 100 KB image is roughly 30 K tokens — that's a measurable share of any context window, and it stays in the conversation for every subsequent turn.

Use `vfs.write` to land the artifact in VFS and return a short markdown link the renderer inlines:

```js
// ✓ GOOD
const bytes = await someApi();
await vfs.writeFile('result.png', bytes);
module.exports = `![result](#${vfs.cwd}/result.png)`;
```

### 3. Putting an API key in the SKILL.md body

The agent reads `SKILL.md` on every invocation. Anything in the body — including a `## Configuration` section with `API_KEY = sk-...` — ends up in the conversation, in chat logs, and in whatever provider's logs the LLM call goes through.

Keep secrets in `scripts/*.js`. The agent only reads script files if it deliberately calls `fs_read_file` on them, which is rare and obvious. With the secret in the script and `bgFetch` in the SW, the secret literally never enters the agent's address space:

```js
// scripts/generate.js
const API_KEY = 'sk-...';  // agent never reads this line
const resp = await bgFetch(ENDPOINT, { headers: { authorization: `Bearer ${API_KEY}` } });
```

### 4. Declaring permissions you don't use

```yaml
# ❌ BAD — script only calls bgFetch, but declared four permissions
metadata:
  permissions:
    - bgFetch:https://api.example.com/*
    - chrome.cookies
    - page.executeJs
    - vfs.write
```

Each permission widens the trust prompt the user sees, and they may approve "Always allow" once and never re-examine. Empty or unused permissions train them to dismiss the prompt without reading it — so the next legitimately scary permission also gets approved blindly.

Minimum privilege: declare only what the script actually calls. If unsure, run the script once with a sparser set; missing permissions cause a clean `TypeError: bgFetch is not a function` (etc.) which is easier to debug than the user finding out later that the skill silently does more than advertised.

## When NOT to ship a skill

Resist the urge to package every workflow as a skill. A skill is the right vehicle when:

- The instructions are non-obvious and the agent benefits from reading them every time.
- The script is reused across many sessions or many users.
- The user should explicitly opt in (`metadata.permissions`) before any script runs.

A skill is the wrong vehicle when:

- The agent could write the same `execute_js` snippet on the fly without losing accuracy.
- The workflow needs no scripts and the instructions are just "summarize the page" — that is a *prompt*, not a skill. Use a `~/.cebian/prompts/*.md` template instead.
- The action is a single browser-API call the agent already has via the `chrome_api` tool. Check before reaching for `run_skill`.
- The single action is "fetch this URL into VFS" — the agent's `fs_save_url` tool already does this with no permission ceremony, and the URL is visible to the user in the conversation.

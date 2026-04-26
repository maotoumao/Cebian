# Injection patterns: when to ship a skill, when to use a tool

Cebian gives the agent two ways to run JavaScript against a page, plus a third way to call browser APIs without touching the page at all. This reference helps you decide which to use when authoring a skill — and when *not* to ship a skill in the first place.

## Three ways to act

| Mechanism | Where it runs | Who invokes it | Persists across sessions |
|---|---|---|---|
| `execute_js` tool | Target tab's main world | Agent, ad hoc | No — agent re-derives the code each time |
| `executeInPage(code)` (skill) | Target tab's main world | Skill script via `run_skill` | Yes — code lives in the skill repo |
| `chrome.<ns>.<method>(...)` (skill) | Sandbox iframe, RPC'd to background | Skill script via `run_skill` | Yes — same |

`execute_js` and `executeInPage` are the same underlying capability with different *origin of code* and *user-trust* envelopes. `chrome.*` from a skill is a separate channel that does not touch the page at all.

## Decision matrix

| You want to... | Use |
|---|---|
| Run a one-off snippet the agent will write fresh per task | `execute_js` (no skill needed) |
| Encode a repeatable workflow that mixes page reads/writes with browser APIs | A skill with `metadata.permissions: [page.executeJs, chrome.<...>]` |
| Call browser APIs (bookmarks, history, cookies, downloads, ...) without touching any page | A skill with `metadata.permissions: [chrome.<...>]` only — **omit `page.executeJs`** |
| Bypass a strict page CSP (`unsafe-eval` blocked) | Either path; both fall back to / use CDP `Runtime.evaluate` |
| Maintain user trust over many sessions | A skill — the user grants permission once, can revoke anytime |
| Avoid the "Cebian started debugging this browser" banner that CDP triggers | Use `chrome.*` only and stay out of `executeInPage` / `execute_js` |

If a script declares `page.executeJs` but never calls `executeInPage`, drop the permission. Declared-but-unused permissions train users to dismiss prompts.

## Cookie matrix (important for security & correctness)

`fetch` behaves very differently depending on where it runs:

| Caller | Origin of `fetch` | Sends cookies for the target site? |
|---|---|---|
| `execute_js` tool | Page's main world (`location.origin`) | **Yes** — same-origin requests carry the user's session cookies, including HttpOnly. Cross-origin requests follow normal CORS + `credentials` rules. |
| `executeInPage(code)` from a skill | Page's main world (same as above) | **Yes** — identical behavior. |
| Top-level `fetch` in a skill script (sandbox) | Opaque sandbox origin | **No** — never carries any site cookies. |
| `chrome.cookies.get/getAll(...)` from a skill | Background, with `cookies` host permission | **Yes (read)** — can read any cookie for any matched origin, including HttpOnly. Use deliberately. |

Implications:

- Anything that should "act as the user" on a website (post a comment, save a bookmark via the site's API, scrape a logged-in page) belongs **inside** `executeInPage` or behind a deliberate `chrome.cookies` flow.
- Anonymous public-API calls (no auth) work fine from the sandbox's top-level `fetch` and avoid the page CSP/CORS entirely.
- Reading session secrets from cookies is a powerful capability. Be explicit in the skill `description` and `metadata.permissions` so the user understands what they are granting.

## CSP and CDP

Both `execute_js` and `executeInPage` ultimately can reach the page via Chrome DevTools Protocol (`Runtime.evaluate`):

- `execute_js` first tries `chrome.scripting.executeScript({ world: 'MAIN' })`. If the page CSP blocks `eval`/`new Function`, it falls back to CDP automatically.
- `executeInPage` always goes through CDP via the `debugger` permission.

CDP-injected code bypasses the page's CSP for `eval`/`new Function`. While any CDP call is in flight, Chrome shows a "Cebian started debugging this browser" banner on the affected tab. The banner is the user's only visible signal that the extension is touching the page — do not try to suppress or downplay it in skill instructions.

## Code-string conventions

Both `execute_js` and `executeInPage` wrap your `code` string as the body of `async () => { CODE }`. Two consequences:

- Use bare `return` to produce a value: `executeInPage('return document.title')`. Top-level `await` is allowed.
- Do **not** wrap your code in an IIFE like `(() => { return x })()` — the inner `return` is swallowed and the result is `null`/empty.
- The return value is always a string when received: strings pass through as-is, non-strings are `JSON.stringify`-ed with 2-space indent, `undefined` becomes `(no return value)`, and exceptions become `Error: <message>`.

## When NOT to ship a skill

Resist the urge to package every workflow as a skill. A skill is the right vehicle when:

- The instructions are non-obvious and the agent benefits from reading them every time.
- The script is reused across many sessions or many users.
- The user should explicitly opt in (`metadata.permissions`) before any script runs.

A skill is the wrong vehicle when:

- The agent could write the same `execute_js` snippet on the fly without losing accuracy.
- The workflow needs no scripts and the instructions are just "summarize the page" — that is a *prompt*, not a skill. Use a `~/.cebian/prompts/*.md` template instead.
- The action is a single browser-API call the agent already has via the `chrome_api` tool. Check before reaching for `run_skill`.

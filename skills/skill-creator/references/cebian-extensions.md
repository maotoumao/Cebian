# Cebian extensions to the agentskills.io spec

What Cebian adds, drops, or interprets differently vs. the upstream [agentskills.io specification](agentskills-spec.md). Read this in addition to `agentskills-spec.md` when authoring a Cebian skill.

## At a glance

| Topic | Upstream spec | Cebian behavior |
|---|---|---|
| `name` rules | 1–64 chars, `[a-z0-9-]`, no leading/trailing/consecutive hyphens | Same. Not enforced at scan time — invalid names are still indexed but are not portable to other agentskills.io clients. |
| `description` length | ≤ 1024 chars | Not strictly enforced. Stay within 1024 for cross-client portability. |
| `compatibility` length | ≤ 500 chars | Not strictly enforced. Same recommendation. |
| `metadata` shape | string→string map | Accepts arbitrary JSON-ish values (arrays, nested maps). |
| `allowed-tools` | Experimental, space-separated | Parsed by the scanner but not surfaced to the agent in the L1 index. |
| `license` | String | Preserved but unused. |
| `disabled` flag | Not in spec | **Cebian extension**: `metadata.disabled: true` removes the skill from the index entirely. |

## What goes into the L1 skills index

The session system prompt includes an `<skills>` block listing every enabled skill. It is rebuilt before every prompt dispatch, so changes take effect on the next turn. For each skill the agent sees:

- `<name>` — frontmatter `name`.
- `<description>` — frontmatter `description`.
- `<metadata>` — the entire `metadata` map, if present.
- `<file>` — tilde-prefixed VFS path to the skill's `SKILL.md`, e.g. `~/.cebian/skills/<name>/SKILL.md` (the agent's `fs_*` tools resolve `~` to `/home/user`).

**Not** in the L1 index: `compatibility`, `license`, `allowed-tools`, body content. Those load only after the agent calls `fs_read_file` on the `<file>` path.

Implication: anything you want the agent to consider when deciding whether to activate the skill must live in `name`, `description`, or `metadata`.

## Recognized `metadata.*` keys

Keys other than the ones below are passed through to the L1 index but have no special meaning. Use them freely for skill-author bookkeeping.

### `matched-url` (string, picomatch glob)

Restricts the skill to a specific URL pattern. Goes into the L1 index as part of `<metadata>`. The agent treats `matched-url` as a one-way **filter**, not an activation signal:

- When present and the active tab URL does **not** match the glob, the skill is suppressed even if its `name` / `description` otherwise would have triggered it.
- When present and the URL matches, activation is still decided by the `name` / `description` signals — `matched-url` alone never activates a skill.
- When absent, the skill is URL-agnostic and the `name` / `description` signals govern alone.

No runtime enforcement — this is honored by the agent based on the preamble instructions, not by a hard filter in the scanner.

```yaml
metadata:
  matched-url: "https://github.com/**"
```

Use globs (`*`, `**`, `?`, `{a,b}`), not regex. Omit entirely if the skill is page-agnostic. Avoid `"*"` — it matches every URL and is equivalent to omitting the field, only noisier.

### `permissions` (string array)

Capabilities the skill's scripts need at execution time. Only consulted by `run_skill`; ignored by the index. Each entry is one of:

- `chrome.<namespace>` — exposes a proxy to a whitelisted `chrome.*` API. See [runtime-api.md](runtime-api.md) for the full whitelist.
- `page.executeJs` — exposes the `executeInPage(code)` async helper to inject JS into a tab.
- `bgFetch` or `bgFetch:<match-pattern>` — exposes the `bgFetch(url, init?)` global, a `fetch`-shaped helper that runs in the background service worker and bypasses CORS. Multiple `bgFetch:` lines OR together; bare `bgFetch` defaults to `*://*/*` (any http(s) URL). Patterns follow Chrome's match-pattern syntax — `https://*.example.com/*`, `*://api.example.com/*`, `<all_urls>`. Match against **scheme + host + pathname only**; do not include query strings or fragments in the pattern. Schemes other than `http` / `https` / `*` are rejected at run setup.
- `vfs.read` / `vfs.write` — exposes a `vfs` global with `fs/promises`-like methods (`readFile`, `writeFile`, `mkdir`, `readdir`, `stat`, `exists`, `unlink`) scoped to the per-session workspace at `/workspaces/<sessionId>/<skill>/`. `vfs.write` automatically implies the read methods on the same scope — declare only `vfs.write` when the skill both produces and inspects its own files. Absolute paths and `..` segments that escape the scope are rejected at the path-resolution layer.

```yaml
metadata:
  permissions:
    - chrome.bookmarks
    - chrome.tabs
    - page.executeJs
    - bgFetch:https://api.example.com/*
    - vfs.write
```

The first time `run_skill` runs a script for a skill that declares any permissions, the run pauses **before the script executes** and the user sees an inline permission card (Deny / Allow once / Always allow this skill) listing the requested permissions in human-readable form. The agent just calls `run_skill` normally — authorization is handled for you. "Always allow" persists per-skill in `chrome.storage.local`; the prompt re-appears if the declared permission set changes. A denial (or the user sending a new message instead of answering) returns an error result and the script does not run.

Omit `permissions` entirely if the skill ships no scripts. Declaring permissions you do not actually use trains the user to dismiss prompts.

### `version` (string)

Free-form version string (SemVer recommended). Optional but encouraged — it is exposed in the L1 index so the agent (and the user, when reading the file) can attribute and compare revisions.

```yaml
metadata:
  version: "1.0.0"
```

### `author` (string)

Free-form author identifier. Not used by the runtime; appears in the L1 index as part of `<metadata>` so the agent can attribute the skill if asked.

### `disabled` (boolean)

Set `disabled: true` to remove the skill from the L1 index without deleting its files. The skill remains on disk, the agent never sees it, and no permission prompts fire.

```yaml
metadata:
  disabled: true
```

## Storage layout

```
~/.cebian/skills/
└── <skill-name>/
    ├── SKILL.md         ← required
    ├── scripts/         ← optional, only if the skill executes code
    ├── references/      ← optional, loaded on demand
    └── assets/          ← optional, templates / fixtures
```

The path `~/.cebian/skills/<name>/SKILL.md` is the canonical entry. Every skill must have a `SKILL.md` at that exact location; the scanner ignores anything else at the top level. Cebian itself never writes into `~/.cebian/skills/` — the directory belongs entirely to the user.

## Index caching

The skill index is cached in memory for 30 minutes. Writes via `fs_create_file`, `fs_edit_file`, and `fs_delete` to any path under `~/.cebian/skills/` invalidate the cache automatically, so a freshly authored or modified skill is picked up on the very next prompt dispatch (the system prompt is rebuilt each turn) — no chat-session restart required.

`fs_mkdir` and `fs_rename` do **not** invalidate the cache. After renaming or creating a skill directory, follow up with `fs_edit_file` on `SKILL.md` (or `fs_create_file` for a brand-new file) to force a refresh.

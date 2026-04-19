# Memory + Tool Context Refactor (PROPOSAL — DO NOT EXECUTE YET)

> **Status:** PROPOSAL — design accepted in principle, scope and details to be re-discussed before planning. Do **not** start implementing without explicit re-approval.
>
> **Why deferred:** Larger, cross-cutting refactor. Should land **before** context compaction (see [`2026-04-19-context-compaction-PROPOSAL.md`](./2026-04-19-context-compaction-PROPOSAL.md)) — that work is blocked on the `SessionContext` introduced here. Sequencing question to revisit: do the SessionContext skeleton (Plan 2a) first, then compaction (Plan 3), then memory itself (Plan 2b)?

---

## Goals (agreed)

1. **Memory tool** — give the agent a persistent, scoped memory backed by VFS (`/.cebian/memory/user/**`, `/.cebian/memory/host/<hostname>/**`, `/workspaces/<sessionId>/memory/**`).
2. **Workspace visibility in chat** — let the user see what files the agent touched, both per-turn (FilesChangedCard) and cumulatively (Header file-count button → opens vfs.html at the session's workspace).
3. **Tool architecture refactor** — replace the current ad-hoc `SessionToolContext` with a clean **Context + Middleware** pair, so cross-cutting concerns (file-change tracking, metrics, logging, future per-session resources, **conversation/compaction state**) stop bleeding into individual tools.
4. **Conversation state hub** — `SessionContext` must own the dual-track `displayMessages` / `modelMessages` / `compactionMarkers` introduced by the compaction PROPOSAL, plus future regenerate/truncate operations. Without this, both compaction and regenerate either bloat `agent-manager.ts` or get implemented twice.

---

## Agreed design highlights

- **`SessionContext`** (renamed from `SessionToolContext`) becomes a **resource bag only**: `sessionId`, `hostname`, `vfs` handle, `abortSignal`. No business logic, no collectors.
- **`ToolMiddleware`** chain wraps every tool's `execute()` in `createSessionTools(sessionId)`. Initial middlewares:
  - `interactiveBridgeMiddleware` (replaces current `SessionToolContext` bridge management)
  - `fileChangeTrackingMiddleware` (intercepts `fs_*`, emits to `ChangeStream`)
  - `errorLoggingMiddleware`
- **`ChangeStream`** (independent, owned by `agent-manager`) — `emit() / drain() / subscribe()`. Drained on `agent_end`, broadcast as new `files_changed` server message.
- **Memory tool** — separate from `fs-*` tools, hard-scoped to the three memory path prefixes via whitelist, with size caps:

  | Layer            | Per-file | Per-directory | Auto-injected into system prompt |
  |------------------|----------|---------------|----------------------------------|
  | user             | 8 KB     | 32 KB         | full                             |
  | host (current)   | 8 KB     | 16 KB / host  | full (only current hostname)     |
  | session          | 4 KB     | 8 KB          | full                             |
  | **session total injected** | — | — | **≤ 56 KB ≈ 14k tokens** |

- **Bootstrap** — first launch seeds `~/.cebian/memory/user/README.md` + empty skeletons; size caps are *enforced* (writes fail with actionable error, no silent LRU eviction).
- **Path strategy** — agent sees real VFS paths, no soft-routing aliases. System prompt declares them explicitly each turn.
- **Header file-count button** — small badge in `Header.tsx` showing the count of files under `/workspaces/<sessionId>/`; click opens `vfs.html#/workspaces/<id>/` in a new tab.
- **FilesChangedCard** — appended to assistant message after `agent_end`, lists `+/~/-/→` operations from the drained `ChangeStream`. Replaces the current "agent must hand-write a markdown link" prompt instruction.

---

## Open questions to revisit when this is unblocked

1. Final shape of `ToolMiddleware` signature (sync vs async, error semantics, ability to short-circuit).
2. Whether `executeJs` / `screenshot` / `tab` / `chromeApi` should also receive `SessionContext` (current proposal: only when they need it).
3. Migration path for `createSessionAskUserTool` — already a factory; needs to be reframed as middleware-aware.
4. Whether host-memory injection should be re-evaluated on tab switch (deferred to v2 in the original discussion).
5. Memory tool surface — match Anthropic's 6-op API (`view/create/str_replace/insert/delete/rename`) or trim?
6. Settings UI for memory browser — reuse `FileWorkspace` component rooted at `/.cebian/memory/`?
7. **Should we split this PROPOSAL into 2a (SessionContext skeleton — pure refactor, prerequisite for compaction) and 2b (memory feature)?** 2a would be small and mechanical; 2b stays a proposal until UX questions land.
8. **`SessionContext` conversation API surface** — what exactly does it expose to tools / agent-manager?
   - `displayMessages` / `modelMessages` (read-only views)
   - `compactionMarkers`
   - `appendDisplayMessage(msg)` (called from `message_end` handler)
   - `truncateAt(displayIdx)` — for regenerate / edit-and-resend
   - `compactIfNeeded()` — turn-boundary trigger
   - `onCompactionStart` / `onCompactionEnd` event emitters (for UI broadcast)
   - `tokenUsage` snapshot
9. **Persistence boundary** — does `SessionContext` own the throttled writer, or does `agent-manager` keep it? Current lean: `SessionContext` owns it, agent-manager just calls `ctx.flush()` on `agent_end`.

---

## When to revisit

After plans 4, 3, and 1 are merged. Re-discuss design end-to-end (especially middleware shape and migration risk) before producing an executable plan.

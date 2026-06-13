# Cebian Development Rules

## Component & Dependency Reuse

- Always reuse existing components and libraries before writing new code. Search the codebase first.
- When a UI component is missing, prefer adding it via shadcn/ui (`shadcn` skill is available).
- Before introducing any third-party dependency, check whether WXT provides a built-in module or recommended integration (see https://wxt.dev). Prefer WXT-ecosystem packages over generic alternatives.

## Plan-First Workflow

All tasks must follow a plan-first approach:

1. **Plan before acting** — Before writing any code, draft an implementation plan listing all steps, files to change, and the expected outcome.
2. **Wait for approval** — Present the plan to the user and **do not proceed** until the user explicitly approves it. Never start coding based on an unapproved plan.
3. **Execute after approval** — Only after the user confirms (e.g., "approved", "go ahead", "looks good") should implementation begin.
4. **Scope changes require re-approval** — If mid-task you discover the plan needs significant changes, stop, present the revised plan, and wait for approval again.

## Task Execution Workflow

Once a plan is approved, execution must follow this strict per-task gating cycle. **Never** batch multiple tasks together or skip ahead.

1. **Split into subtasks** — Break the approved plan into concrete, individually verifiable subtasks. Use the `manage_todo_list` tool to create a TODO list so progress is visible to the user.
2. **One task at a time** — Mark exactly one subtask as `in-progress` and complete only that subtask before touching the next. Do not start subsequent tasks in the same turn.
3. **Code review after each task** — Immediately after finishing a subtask's implementation, invoke the `code-review` subagent on the changes for that subtask alone. Address any issues it raises before proceeding. **If the review surfaces fixes, refactors, or design changes that go beyond the scope of the original approved plan** (e.g., extracting a new shared module, refactoring an unrelated file, changing an established pattern), **stop and confirm with the user before applying them** — present what the reviewer suggested, why, and the proposed change, then wait for explicit approval. Only purely in-scope fixes (bugs, dead code, typos within the subtask's own files) may be applied without re-confirmation.
4. **Provide testing instructions** — After code review passes, give the user clear, concrete steps to manually verify the subtask (what to open, what to click, what to look for, what console output to expect, etc.). Then **stop and wait**.
5. **Wait for test feedback** — Do not start the next subtask while the user is still testing or has open questions. Answer questions and fix issues they report on the current subtask first.
6. **Wait for explicit approval** — Only after the user explicitly approves the current subtask (e.g., "approved", "next", "looks good", "passed") may you mark it completed and move on to the next subtask. Silence, acknowledgements, or unrelated messages are **not** approval.
7. **Repeat** — Restart the cycle at step 2 for the next subtask.

If a subtask reveals the plan is wrong, stop and trigger the Plan-First re-approval flow above instead of pushing forward.

## Architecture Validation

Before writing any code, verify placement and structure:

- Is this the correct file/directory for this logic?
- Does this follow the existing project conventions (see `components/`, `hooks/`, `lib/`, `entrypoints/`)?
- Would this change require restructuring existing modules? If so, propose the restructuring plan before implementing.
- Avoid creating unnecessary abstractions, helpers, or wrapper files for one-off operations.

### Cohesion, coupling, and file size

- **High cohesion** — each file/module focuses on a single concern. Don't mix UI, IO, and business rules in one file.
- **Low coupling** — respect the established layering between `entrypoints/`, `components/`, `hooks/`, and `lib/`. Read existing imports to understand the direction; don't introduce reverse or cross-layer dependencies.
- **File size signal** — single files growing past ~300 lines should be evaluated for splitting along a clear seam. This is a signal, not a rule — a long file with genuinely high cohesion is fine, and a short file that mixes concerns still needs splitting. Don't design for design's sake.

### Naming & module API

Names carry the design. Get them right the first time — the user reviews names closely and will push back on confusing ones.

- **Name what it does, not how.** A name states its effect, not its mechanism. `fillMissing` beats `restoreMerge`; `collectStorage` beats anything mentioning Dexie / `chrome.storage`. Implementation details (transport, backend, `viaBackground`, IPC) never belong in a public name — callers only care about the semantic action.
- **Make the layer visible when names collide.** When two symbols sit at different layers but share a verb, rename so the layer shows. Page-side IPC entry `restoreSessions` vs background-only pure decision `planSessionWrites` — never leave two `restore*` reading as if they were the same level. State the execution context in a comment when it isn't obvious.
- **Parallel modules share one verb vocabulary.** Sibling modules doing the same job use identical verb patterns — every backup source exposes `collect<Source>` / `restore<Source>`. A reader learns the shape once and applies it everywhere.
- **Organize by the thing, not the direction.** Split files by data source / domain entity, each holding both directions (every `lib/backup/sources/*.ts` has both collect and restore), not by operation. Don't mix naming dimensions across siblings (one file named by direction, another by source).
- **One concept, one type.** Don't split a single concept into near-duplicate types — collapse `VfsMultiRootGroup` + `VfsSingleRootGroup` into one `VfsRootGroup { roots: string[] }`. A "more complete looking" pair of shapes is usually one shape.
- **Exports at the bottom.** Put the public API at the end of the file, with types and internal helpers above, so opening the file shows "what this module offers" first. Group exports by audience when a file serves more than one (e.g. a "source API" block and an "IPC wire contract" block).

## Code Comments

- 注释优先使用中文，其次是英文。必要的术语（API 名称、库名、协议字段、错误码等）保持英文即可，不要强行翻译。
- Comments should be written in Chinese first, English as fallback. Keep necessary technical terms (API names, library names, protocol fields, error codes, etc.) in English — do not force-translate them.
- 这一规则只针对新增或修改的注释。不要为没有动过的代码补注释，也不要把现有的英文注释批量翻译成中文。

## Tool Failure Handling

Cebian's agent tools (`lib/tools/*`) implement `AgentTool` from `@earendil-works/pi-agent-core`. The protocol is literal: throw on failure, return on success.

- **Real errors → `throw new Error(<message>)`** (network, invalid input, missing resources, permission denied, parse failure). pi-agent-core sets `message.isError = true`, which flows to `is_error: true` in the LLM payload so the model's retry / replan engages. The thrown `Error.message` is the only thing the LLM sees — phrase it actionably.
- **Empty results → `return` success with descriptive content** (0 search hits, empty directory, 0 elements matched, PDF has no text layer, chrome API returned undefined). The agent must be able to act on these calmly. Tiebreaker: "can the agent reasonably proceed from this result?" Yes → return; no → throw.
- **Never re-encode a thrown error as a successful return.** Re-encoding breaks the `isError` signal. `try/catch` itself is fine when the catch branch ends in `throw` — common uses: translating a library exception into an LLM-friendly message (`URL` constructor → "Invalid URL: ...", `parseFrontmatter` → "Failed to parse SKILL.md: ..."), translating a typed error from a library (`mcp-tool.ts` translates `ThrottleError` → friendlier wording), or preserving `AbortError` / `signal.aborted` rethrow so pi-agent-core's cancellation contract still fires (see `fs-save-url.ts`'s fetch handshake catch). `try/finally` for resource cleanup (reader locks, abort listeners, tab-restore) is always fine.
- **In-page injected functions** (`chrome.scripting.executeScript`) may return a `"Error: ..."` sentinel string instead of throwing, because chrome.scripting swallows in-page rejections. The calling tool **must** translate that sentinel into a real throw at the extension layer before returning — see `runInPageStep` in `interact.ts` for the canonical example.
- **`details` is a per-tool structured side channel** for UI / logs / persistence; the LLM never sees it. Tools define their own shape (`mcp-tool.ts` uses `{ server, tool, structured, mcpApp? }`; `ask-user.ts` declares a named `AskUserDetails` interface — preferred style for typed details); use `{}` when nothing useful to surface. Don't add a `status` field — that question is now answered by `message.isError`.

## Debugging & Troubleshooting

- When investigating a bug, if the root cause is uncertain or multiple rounds of investigation haven't resolved it, **stop guessing** — add targeted `console.log` / `console.warn` statements at the suspicious code paths and ask the user to reproduce the issue so the logs can be collected.
- Clearly tell the user what to do (e.g., "open the sidepanel, trigger X, then share the console output") and what information you need from the logs.
- Do not keep making speculative fixes without evidence. Logging → user feedback → informed fix.

## Testing

Unit tests use **Vitest** with the **`WxtVitest`** plugin (`wxt/testing/vitest-plugin`), which polyfills the extension `browser` API in-memory (`@webext-core/fake-browser`), wires `#imports` auto-imports, and configures the `@/*` alias — so tests can import production modules exactly as source code does.

- **Unit tests are co-located** — a unit test lives **next to the file it tests**, as a same-named `*.test.ts` in the same directory (e.g. `lib/backup/registry.ts` → `lib/backup/registry.test.ts`). Imports still use the `@/` alias.
- **Not every file needs a test** — only cover high-risk pure logic where a silent bug corrupts or leaks data: crypto (encrypt/decrypt round-trips, wrong-password failure), merge/replace semantics, secret split/recombine, manifest parsing, path-safety predicates. Don't chase coverage on trivial glue or UI wiring — those are verified manually.
- **`test/` is for E2E / integration only** — the top-level `test/` folder is reserved for future tests that wire multiple modules together end-to-end. There are none yet, so the folder does not exist. Do NOT put unit tests there.
- **Run** — `pnpm test` (watch) / `pnpm test:run` (single pass). `pnpm check` runs `test:run` after typecheck + i18n lint.
- **Storage in tests** — do NOT mock `chrome.storage` / WXT storage items. `fakeBrowser` implements storage in-memory; call `fakeBrowser.reset()` in `beforeEach`. Set state by calling the real storage item's `setValue`, then assert via `getValue`.
- **Mocking `#imports`** — vitest sees the resolved import paths, not `#imports`. To mock a WXT util, `vi.mock` its real path (look it up in `.wxt/types/imports-module.d.ts`), not `'#imports'`.
- **Exhaustiveness / registry guards** — when a registry or discriminated union must stay in sync with another source of truth (e.g. every storage item must be classified), back it with a test that enumerates the source and asserts completeness, so an omission fails CI instead of silently slipping through.

## Post-Task Code Review

After completing all coding for a task, invoke the `code-review` agent as a subagent to perform a senior-level code review. Fix any issues found before reporting completion.

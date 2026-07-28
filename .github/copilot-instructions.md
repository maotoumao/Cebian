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

Once a plan is approved, execution must follow this strict per-task gating cycle. **Never** batch multiple subtasks together or skip ahead.

> **🛑 HARD STOP after every subtask (non-negotiable).** The moment you finish ONE subtask's implementation + its `code-review` pass and have posted its testing instructions, you **MUST end your turn and wait**. In that same turn you may **not** start, plan, scaffold, refactor toward, or "get a head start on" the next subtask — stop completely.
>
> This holds **even when the user has already said "do all of them", "do them in order", "都做", "继续", "按顺序处理", or approved the overall plan.** A blanket go-ahead approves the **plan**, not the individual subtask gates — each subtask still needs its **own explicit** per-subtask approval (e.g. "next", "approved", "通过", "下一个") before you touch the following one. "Do them in order" means "in this order, one gated stop at a time", **never** "do them back-to-back without stopping".
>
> If you catch yourself about to begin a second subtask in one turn — or rationalizing that the user "clearly wants all of it" — that is the violation. Stop and hand control back. When unsure whether something counts as a new subtask, assume it does and stop.

1. **Split into subtasks** — Break the approved plan into concrete, individually verifiable subtasks. Use the `manage_todo_list` tool to create a TODO list so progress is visible to the user.
2. **One task at a time** — Mark exactly one subtask as `in-progress` and complete only that subtask before touching the next. Do not start subsequent tasks in the same turn.
3. **Code review after each task** — Immediately after finishing a subtask's implementation, invoke the `code-review` subagent on the changes for that subtask alone. Address any issues it raises before proceeding. **If the review surfaces fixes, refactors, or design changes that go beyond the scope of the original approved plan** (e.g., extracting a new shared module, refactoring an unrelated file, changing an established pattern), **stop and confirm with the user before applying them** — present what the reviewer suggested, why, and the proposed change, then wait for explicit approval. Only purely in-scope fixes (bugs, dead code, typos within the subtask's own files) may be applied without re-confirmation.
4. **Provide testing instructions** — After code review passes, give the user clear, concrete steps to manually verify the subtask (what to open, what to click, what to look for, what console output to expect, etc.). Then **stop and wait**.
5. **Wait for test feedback** — Do not start the next subtask while the user is still testing or has open questions. Answer questions and fix issues they report on the current subtask first.
6. **Wait for explicit approval** — Only after the user explicitly approves the current subtask (e.g., "approved", "next", "looks good", "passed") may you mark it completed and move on to the next subtask. Silence, acknowledgements, or unrelated messages are **not** approval.
7. **Repeat** — Restart the cycle at step 2 for the next subtask.

If a subtask reveals the plan is wrong, stop and trigger the Plan-First re-approval flow above instead of pushing forward.

**Changelog gate** — 当整个任务（非每个子任务）含有用户可见变更时，在报告完成前须按「Changelog」章节的规则在 `CHANGELOG.md` 的 `## [Unreleased]` 追加条目。纯内部重构 / 测试 / 构建 / 依赖升级等终端用户感知不到的变更可不记。
When the overall task (not each subtask) carries user-visible changes, append entries to `## [Unreleased]` in `CHANGELOG.md` per the Changelog section before reporting completion. Internal-only churn (refactor / test / build / dependency bumps users can't perceive) may be skipped.

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
- **Name a value for what it is, not its role in one caller.** A parameter or field is named by the thing it carries, not by how a single call site happens to use it. `turn` (the per-turn model / thinking a message carries) beats `override` (its effect relative to a default); `identity` beats `requested`. The control-flow role belongs in the code that compares the value, never in its name.
- **Drop noise suffixes that carry no information.** `Obj` / `Data` / `Info` / `Result` add length without meaning — the signature already says what a value is. `resolveModel` beats `resolveModelObj`; `model` beats `modelData`.
- **Make the layer visible when names collide.** When two symbols sit at different layers but share a verb, rename so the layer shows. Page-side IPC entry `restoreSessions` vs background-only pure decision `planSessionWrites` — never leave two `restore*` reading as if they were the same level. State the execution context in a comment when it isn't obvious.
- **Parallel modules share one verb vocabulary.** Sibling modules doing the same job use identical verb patterns — every backup source exposes `collect<Source>` / `restore<Source>`. A reader learns the shape once and applies it everywhere.
- **Organize by the thing, not the direction.** Split files by data source / domain entity, each holding both directions (every `lib/backup/sources/*.ts` has both collect and restore), not by operation. Don't mix naming dimensions across siblings (one file named by direction, another by source).
- **One concept, one type.** Don't split a single concept into near-duplicate types — collapse `VfsMultiRootGroup` + `VfsSingleRootGroup` into one `VfsRootGroup { roots: string[] }`. A "more complete looking" pair of shapes is usually one shape.
- **Rename the moment a name stops matching reality.** Names drift as code evolves; a stale name is the most expensive kind of comment. A type that generalized from "the active model" to "any model identity" becomes `ModelIdentity`, not `ActiveModel`; a storage item that became a new-chat seed stops calling itself `activeModel`. Caveat — a code symbol renames freely, but a **persisted key or wire-protocol field is an external contract**: rename the JS export, never the underlying `local:...` storage key or protocol field name (that silently breaks existing user data and back-compat).
- **Exports at the bottom.** Put the public API at the end of the file, with types and internal helpers above, so opening the file shows "what this module offers" first. Group exports by audience when a file serves more than one (e.g. a "source API" block and an "IPC wire contract" block).
- **Keep the exported surface minimal.** Un-export a symbol the moment its last cross-file caller disappears — `buildSystemPrompt` stopped being exported once only its own module used it. A narrower public API is cheaper to refactor and signals what is truly shared.

### `lib/` internal organization (where a new lib file goes)

`lib/` is organized **by concept, not by execution context**. A concept that spans both background and UI (connected by IPC) stays *whole* in one folder — never split a concept into `background/` vs `ui/` folders. The execution context shows up in the **file name**, not the folder. Decide placement with this tree:

1. **Used by exactly one entrypoint and not reusable?** → it belongs in that `entrypoints/<ctx>/`, **not** in `lib/`. `lib/` is only for code shared across contexts, or pure utilities.
2. **Pure utility — no Cebian domain, no platform binding, importable from anywhere (bg/UI/content/sandbox)?** → `lib/` root (this is why only `utils.ts` and `i18n.ts` live at the root).
3. **Belongs to an existing concept?** → put it in that concept folder; encode the execution context in the filename:
   - bare name / `types.ts` / `client.ts` = shared across contexts
   - `*-channel.ts` = UX-side IPC entry (only UI imports it)
   - `manager.ts` = background-side orchestration (only background imports it)
4. **A new concept?** → only create a folder once it has **≥2 cohesive files**. A single-file concept stays a single file (in the nearest concept folder or at root) until a second context-specific file appears, then it graduates to a folder. Don't pre-build a folder for a split that hasn't happened.
5. **Domain content (system prompts, injected preamble text, a config table bound to one concept)** → travels with its concept, **never** into a generic `constants.ts` grab-bag. (There is intentionally no `lib/constants.ts`.)

The current concept/capability folders and their boundaries:

| Folder | Concept / capability | Import boundary |
| --- | --- | --- |
| `agent/` | conversation runtime (attachments, message parsing, compaction, tool-permissions) | — |
| `providers/` | AI provider connectivity (oauth, custom-models, registry) | — |
| `ipc/` | cross-context messaging (protocol, instance-id, sandbox-binary) | — |
| `persistence/` | data-at-rest (db, vfs, storage, vfs-paths) | platform: IndexedDB / chrome.storage |
| `browser/` | chrome / CDP / page injection (tab-actions, mobile-emulation, element-picker) | content scripts must NOT import |
| `ui/` | needs `document` / React / toast (dialog, clipboard) | background must NOT import |
| `content/` | file-format helpers (mime, frontmatter, pdf-loader) | pure |
| `ai-config/` `backup/` `mcp/` `recorder/` `tools/` | established domains | — |
| `shims/` | third-party patches (not our concept) | — |

The **capability** folders (`persistence/` / `browser/` / `ui/` / `content/`) encode an import-direction rule in their name — a reviewer can spot a violation from the import path alone (e.g. `entrypoints/background/*` importing `@/lib/ui/*` is wrong).

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

## Changelog

项目根目录维护单一的 `CHANGELOG.md`，格式遵循 [Keep a Changelog](https://keepachangelog.com/) + 语义化版本，中英双语。
The repo keeps one root `CHANGELOG.md` following Keep a Changelog + SemVer, bilingual (Chinese + English).

**What to record / 记什么** — 只记终端用户能感知的变更：新功能、行为变化、Bug 修复、面向用户的破坏性变更。纯重构、测试、构建、内部依赖升级（除非影响用户）一般不记。来自 issue 的变更在条目末尾附 `(#编号)`。

**Where / 写到哪** — 日常一律写入顶部的 `## [Unreleased]`。已发布的版本节（如 `## 1.3.2 - 2026-06-14`）**只读，永不修改**。写入前先读完整个 `[Unreleased]`，往已有小节追加，不要重复建小节。

**Sections / 小节** — `### 新增 / Added`、`### 变更 / Changed`、`### 修复 / Fixed`、`### 移除 / Removed`、`### 破坏性变更 / Breaking Changes`（按需出现）。

**Bilingual layout / 双语排版** — 每个小节正文**先列全部中文条目，空一行，再列全部对应英文条目**（顺序一一对应），不要逐行中英并排、不用 `/` 在条目内分隔中英。小节标题用 `中文 / English`。

**Release cut-over / 发版收口** — 在改 `package.json` 版本号的发版提交里，把 `## [Unreleased]` 重命名为 `## X.Y.Z - YYYY-MM-DD`，并在顶部补一个新的空 `## [Unreleased]`。这一步**由人/AI 手动完成**（可用 `/cl` prompt 辅助审计补漏），**CI 不自动搬运** `[Unreleased]` 内容——CI 仅负责按 Changelog 内容发布 Release notes。

## Post-Task Code Review

After completing all coding for a task, invoke the `code-review` agent as a subagent to perform a senior-level code review. Fix any issues found before reporting completion.

The review must also confirm the **Changelog gate**: if the task carries user-visible changes, check that `## [Unreleased]` was updated and that the new entries follow the format in the Changelog section (bilingual blocks, correct subsection, no edits to released version sections).

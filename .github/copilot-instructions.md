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

## Debugging & Troubleshooting

- When investigating a bug, if the root cause is uncertain or multiple rounds of investigation haven't resolved it, **stop guessing** — add targeted `console.log` / `console.warn` statements at the suspicious code paths and ask the user to reproduce the issue so the logs can be collected.
- Clearly tell the user what to do (e.g., "open the sidepanel, trigger X, then share the console output") and what information you need from the logs.
- Do not keep making speculative fixes without evidence. Logging → user feedback → informed fix.

## Post-Task Code Review

After completing all coding for a task, invoke the `code-review` agent as a subagent to perform a senior-level code review. Fix any issues found before reporting completion.

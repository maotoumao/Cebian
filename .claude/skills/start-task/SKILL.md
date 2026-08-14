---
name: start-task
description: "Resume execution of an approved plan from the next unchecked subtask, following the gated Task Execution Workflow in AGENTS.md."
argument-hint: "Optional: path to plan file (defaults to most recent in docs/plans/)"
disable-model-invocation: true
---

Resume work on an in-progress plan. Follow the **Task Execution Workflow** defined in [AGENTS.md](../../../AGENTS.md) strictly — one subtask, code review, test instructions, then stop.

## Steps

1. **Locate the plan**
   - If the user provided a path, use that file.
   - Otherwise list [docs/plans/](../../../docs/plans/) and pick the most recently modified `*.md` plan that is not marked `PROPOSAL`. Confirm the choice with the user in one short line before proceeding.

2. **Find the next subtask**
   - Read the plan and locate the first `## Task N:` section that still contains unchecked `- [ ]` steps.
   - If every task is fully checked, report "All tasks complete" and stop. Do not invent new work.

3. **Sync the TODO list**
   - Use your harness's todo/task list to mirror the plan's tasks. Mark already-completed tasks as `completed`, the located next task as `in-progress`, and remaining tasks as `not-started`.

4. **Execute exactly that one subtask**
   - Implement only the steps inside that single `## Task N:` section.
   - Do not touch files belonging to later tasks. Do not look ahead.
   - When the implementation is done, update the plan file to check off (`- [x]`) the steps you completed.

5. **Code review**
   - Run the `/code-review` skill on the diff for this subtask only (pass it the list of files you changed in this task and the plan section as context). Address any actionable issues before continuing.

6. **Hand off to the user**
   - Provide concrete manual testing instructions: what to run (`pnpm dev` is usually already running in the `dev` terminal), what to open, what to click, expected console output, expected UI state.
   - Then **stop**. Do not start the next task. Do not mark the TODO `completed` yet.

7. **Wait for explicit approval**
   - Only after the user replies with explicit approval (e.g., "approved", "next", "looks good", "passed") should the TODO be marked `completed`. Acknowledgements and silence are not approval.

If the plan turns out to be wrong or incomplete during step 4, stop and trigger the **Plan-First** re-approval flow instead of pushing forward.

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

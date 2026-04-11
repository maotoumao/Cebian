# Cebian Development Rules

## Component & Dependency Reuse

- Always reuse existing components and libraries before writing new code. Search the codebase first.
- When a UI component is missing, prefer adding it via shadcn/ui (`shadcn` skill is available).
- Before introducing any third-party dependency, check whether WXT provides a built-in module or recommended integration (see https://wxt.dev). Prefer WXT-ecosystem packages over generic alternatives.

## Architecture Validation

Before writing any code, verify placement and structure:

- Is this the correct file/directory for this logic?
- Does this follow the existing project conventions (see `components/`, `hooks/`, `lib/`, `entrypoints/`)?
- Would this change require restructuring existing modules? If so, propose the restructuring plan before implementing.
- Avoid creating unnecessary abstractions, helpers, or wrapper files for one-off operations.

## Post-Task Code Review

After completing all coding for a task, create a subagent to perform a senior-level code review. The review must check:

1. **Best practices** — idiomatic React/TypeScript, proper hook usage, correct WXT patterns
2. **Dead code** — no unused imports, variables, functions, or unreachable branches
3. **Correctness** — logic is correct, edge cases handled at system boundaries
4. **Architecture** — placement is reasonable, no misplaced concerns, clean separation
5. **Error handling** — no silent failures, no swallowed exceptions
6. **Performance** — no unnecessary re-renders, no expensive operations in hot paths, proper memoization where needed

Use the `Explore` agent with thoroughness `thorough` for this review. Fix any issues found before reporting completion.

# Contributing to Cebian

**[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)**

Thanks for your interest in contributing! This document describes how to
get set up and what we expect from contributions.

## Code of Conduct

Be respectful, be constructive. Harassment or abusive behavior will not
be tolerated.

## Development Setup

```bash
pnpm install
pnpm run dev          # Chrome dev mode
pnpm run dev:firefox  # Firefox dev mode
pnpm run check        # type-check + i18n lint (runs as pre-commit hook)
pnpm run build        # production build
```

See [README.md](README.md) for more details.

### Optional: auto-seed a dev AI provider

Copy `.env.example` to `.env.local` and fill in `WXT_DEV_API_KEY` plus the
companion fields. On the next `pnpm run dev` launch the extension will
auto-create a custom OpenAI-compatible provider so you can skip the manual
setup wizard on a fresh install. The seed only runs in dev mode and only
when the API key is non-empty; production builds skip the logic entirely.
An existing provider with the same id is never overwritten.

## Before You Open a PR

To keep implementation aligned with the project's direction, **PRs must be
tied to a maintainer-approved issue**. The flow is:

1. **Open or find an issue** describing the bug or feature, and discuss your
   proposed approach there.
2. **Wait for approval.** The maintainer replies `/ready` on the issue, which
   applies the `ready-to-implement` label. This signals the approach is agreed
   upon and the issue is open for implementation.
3. **Then open your PR**, referencing the issue with `Closes #<issue number>`
   in the description.

PRs that are **not** linked to an issue carrying the `ready-to-implement`
label are **automatically closed** by a bot, with a comment explaining how to
proceed. Don't worry — once the linked issue is approved, just reopen the PR
and it will pass the check. PRs opened by maintainers and collaborators are
exempt from this gate.

## Contribution Workflow

1. Fork the repository and create a branch from `master`.
2. Make your changes. Keep commits focused and the diff minimal.
3. Run `pnpm run check` locally before pushing.
4. Open a Pull Request against `master`, reference the approved issue with
   `Closes #<issue number>`, and tick the CLA checkbox in the PR template to
   confirm you agree to the CLA.

## Contributor License Agreement (CLA)

Before we can accept your pull request, you must agree to the
[Cebian Individual Contributor License Agreement](CLA.md).

**In short**, the CLA means:

- You keep copyright on your contribution.
- You grant the maintainer a broad license to use, relicense, and
  sublicense your contribution.
- You confirm you have the right to contribute the code.

When you open a Pull Request, simply tick the CLA checkbox in the PR
template to indicate your agreement.

## Licensing

Cebian is licensed under [AGPL-3.0-only](LICENSE). Your Contributions
are contributed to the Project under AGPL-3.0-only, and You
additionally grant the Maintainer the rights described in the
[CLA](CLA.md) (including relicensing rights as set out there).

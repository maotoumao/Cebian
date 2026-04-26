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

## Contribution Workflow

1. Fork the repository and create a branch from `master`.
2. Make your changes. Keep commits focused and the diff minimal.
3. Run `pnpm run check` locally before pushing.
4. Open a Pull Request against `master`, and tick the CLA checkbox in
   the PR template to confirm you agree to the CLA.

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

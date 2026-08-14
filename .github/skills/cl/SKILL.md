---
name: cl
description: 审计自上次发版以来的提交，把遗漏的「用户可见变更」补进 CHANGELOG.md 的 [Unreleased]；可选地把 [Unreleased] 收口成正式版本节
argument-hint: 可选——传版本号（如 1.3.3）表示要发版收口；留空则只做审计补漏，不收口
disable-model-invocation: true
---

Before acting, read and follow the [canonical skill](../../../.agents/skills/cl/SKILL.md) in full.

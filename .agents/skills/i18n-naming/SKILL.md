---
name: i18n-naming
description: Cebian project i18n key naming, placeholder, pluralization, file layout, and glossary conventions. MUST be used whenever adding, editing, refactoring, or reviewing any translation key in `locales/*.yml`, any `t(...)` call in source code, or any `__MSG_*__` placeholder in manifest. Also triggers when reviewing diffs that touch i18n files, when proposing new user-facing strings, or when validating translation completeness/consistency between `en.yml` and `zh_CN.yml`.
---

# Cebian i18n Naming & Convention Skill

This skill captures the agreed-upon rules for the Cebian extension's i18n
implementation, built on `@wxt-dev/i18n` with its simple YAML format. All
translation work — both authoring and review — must follow these rules.

## When to apply

- Adding any new `t('...')` call in source.
- Editing `locales/en.yml` or `locales/zh_CN.yml` (NEVER edit `zh_TW.yml`; it is auto-generated).
- Reviewing a diff that touches i18n.
- Validating that a translation set is complete & consistent.
- Adding a manifest-level localized string (`__MSG_*__`).

## Languages & file layout

Cebian ships **two** locales:

- `en` — default (fallback for all non-Chinese users)
- `zh_CN` — Simplified Chinese for Mainland users
- `zh_TW` — auto-mirrored from `zh_CN` for Taiwan/HK users (Cebian
  intentionally serves Simplified to all Chinese variants per project
  decision; Chrome's `_locales` directory does not accept a bare `zh`)

Source files live at:

```
locales/en.yml
locales/zh_CN.yml   # single source of truth for Chinese
locales/zh_TW.yml   # auto-generated, DO NOT EDIT
```

`scripts/sync-zh-locales.mjs` mirrors `zh_CN.yml` into `zh_TW.yml`
before every `wxt prepare`, `wxt`, `wxt build`, and `wxt zip` run. The
WXT module then compiles them into
`.output/<browser>/_locales/{en,zh_CN,zh_TW}/messages.json` at build
time. Never edit generated `messages.json` files by hand, and never
edit `zh_TW.yml` by hand.

## Key naming rules

### Namespace hierarchy

Use a fixed top-level namespace set. Do not invent new top-level namespaces
without updating this skill first.

```
common      # generic verbs/labels reused across UI (send, cancel, save, ...)
chat        # /chat/* page (input, message, tools)
settings    # /settings/* page (layout, providers, instructions, prompts, skills, advanced, about)
provider    # provider sub-components (oauth, apiKey, custom)
dialogs     # modal dialogs
errors      # toast / inline error messages
agent       # agent-runtime user-facing strings

# Flat top-level keys (manifest exception, see "Manifest localization"):
# extName, extDescription, actionTitle
```

### Key syntax

- Dot-separated path: `namespace.block.name` (e.g. `chat.input.placeholder`).
- Each segment is **lowerCamelCase**: `apiKey` not `api-key`, not `api_key`.
- Final segment names the *thing*, not the *element type*.
  - Good: `common.cancel`, `errors.fileTooLarge`
  - Bad: `common.cancelButton`, `errors.fileTooLargeMessage`
- Action labels use a verb: `common.send`, `common.delete`.
- Status labels use an adjective/past participle: `provider.oauth.loggedIn`.
- Errors live under `errors.*` and read as a sentence.

### Reuse vs duplication

Prefer **one canonical key per concept**, reused across the UI, over
near-duplicates. Every "Cancel" button must use `common.cancel`. Add a
non-`common` key only when the wording legitimately differs in context.

## Placeholders

`@wxt-dev/i18n`'s simple YAML format only supports **positional**
substitutions `$1`–`$9`. Named placeholders (`$NAME$`) are only available
via the verbose Chrome `messages.json` format, which we do not use.

### Rules

- Use `$1`, `$2`, ... `$9` in message text.
- Document the meaning of each `$N` with an inline YAML comment **on the
  line above the message**, so translators see what they are.
- Pass substitutions as an array literal at the call site, in the **same
  order** as the comment documents.

```yaml
errors:
  # $1 = file name, $2 = size limit
  fileTooLarge: "$1 exceeds $2 limit"
```

```ts
t('errors.fileTooLarge', [file.name, '5MB']);
```

### Escaping

To produce a literal `$`, double it: `$$`.

### Word-order differences across locales

If natural sentence order differs between en and zh, **keep the indices
the same and rearrange the surrounding text**:

```yaml
# en.yml — $1 = model, $2 = provider
chat.modelLine: "Using $1 from $2"

# zh.yml — same indices, different surrounding text
chat.modelLine: "正在使用 $2 的 $1"
```

The call site `t('chat.modelLine', [model, provider])` works for both.

### Forbidden in placeholder values

- HTML or markdown — placeholders interpolate as plain text.
- Nested translation calls — compose at the call site instead.

## Pluralization

`@wxt-dev/i18n` plural syntax (NOT i18next's `_one`/`_other` suffixes).
A pluralized key is a map with numeric keys plus `n`:

```yaml
chat:
  history:
    # $1 = count
    count:
      0: "No messages"
      1: "1 message"
      n: "$1 messages"
```

Call with the count as the **second argument**:

```ts
t('chat.history.count', 0);   // "No messages"
t('chat.history.count', 1);   // "1 message"
t('chat.history.count', 5);   // "5 messages"
```

Chinese has no plural form, but **must still provide the same shape** so
the key set is symmetric:

```yaml
chat:
  history:
    count:
      0: "暂无消息"
      1: "1 条消息"
      n: "$1 条消息"
```

## Manifest localization

For `manifest.json` fields use `__MSG_<key>__` placeholders. **Chrome
restricts the key to `[a-zA-Z0-9_]`** — dots are not allowed inside the
placeholder. Therefore manifest keys are an **exception to the
namespace rule** and live as flat top-level entries in the YAML files:

```yaml
# en.yml
extName: "Cebian"
extDescription: "AI-powered browser sidebar assistant"
actionTitle: "Open Cebian sidebar"

# (all other keys remain nested under their namespace)
common:
  newChat: "New chat"
```

```ts
// wxt.config.ts
manifest: {
  default_locale: 'en',
  name: '__MSG_extName__',
  description: '__MSG_extDescription__',
  action: { default_title: '__MSG_actionTitle__' },
}
```

The allow-list of flat top-level keys is fixed:
`extName`, `extDescription`, `actionTitle`. Adding a new flat key
requires updating this skill.

## Glossary (canonical translations)

Authoritative. Any deviation must be discussed and added here.

| EN                | 简体中文     | Notes                              |
| ----------------- | ------------ | ---------------------------------- |
| Cebian            | Cebian       | Brand name, never translated       |
| Provider          | 提供商       | Not 供应商                          |
| Model             | 模型         |                                    |
| Skill             | 技能         | Translated                         |
| Prompt            | 提示词       | Translated                         |
| Agent             | 智能体       | Not 代理 (ambiguous with proxy)    |
| Tool              | 工具         |                                    |
| Session / Chat    | 会话         |                                    |
| Thinking          | 思考         |                                    |
| Settings          | 设置         |                                    |
| Sidepanel         | 侧边栏       |                                    |
| Token             | Token        | Keep English                       |
| API Key           | API Key      | Keep English                       |
| OAuth             | OAuth        | Keep English                       |
| Sign in / Login   | 登录         |                                    |
| Sign out / Logout | 退出         |                                    |
| Verify            | 验证         |                                    |
| Save              | 保存         |                                    |
| Cancel            | 取消         |                                    |
| Delete            | 删除         |                                    |
| Confirm           | 确认         |                                    |
| New chat          | 新对话       |                                    |
| History           | 历史         |                                    |

## Style rules

- **Buttons / menu items**: imperative verb phrase, no trailing punctuation.
  - en: `Send`, `Open in new tab`
  - zh: `发送`、`在新标签页打开`
- **Tooltips / aria-label**: same as button text unless it adds info.
- **Toasts**:
  - Success: short statement, no exclamation. en: `Saved` / zh: `已保存`
  - Error: state what failed and (when actionable) why.
- **Placeholders / empty states**: hint, not instruction.
  - en: `Search models…`  zh: `搜索模型…`
- **Sentence punctuation**:
  - en: ASCII punctuation (`. , ! ? : ;`).
  - zh: full-width Chinese punctuation (`。，！？：；`).
  - Ellipsis: single character `…` for both, **never** `...`.
- **Length budget**: a zh string used inside a button or badge should not
  exceed the en string by more than ~30% in rendered width.
- **Capitalization (en)**: sentence case for body text and tooltips,
  Title Case only for proper nouns and section headings.

## Authoring workflow

1. Add the key to `locales/en.yml` first.
2. Add the same key to `locales/zh_CN.yml`.
   **Never edit `locales/zh_TW.yml` — it is auto-mirrored from `zh_CN.yml`
   by `scripts/sync-zh-locales.mjs` on every build.**
3. Update the call site to `t('your.key')` (or `t('your.key', [arg1, ...])`).
4. If using positional placeholders, document the meaning of each `$N`
   with an inline YAML comment on the preceding line, in both locales.
5. Run `pnpm compile` (and `pnpm lint:i18n` during the migration phase).

## Review checklist

Run through this list explicitly when reviewing any i18n-touching diff.
Cite each item as pass/fail.

1. **Key parity**: every key in `en.yml` exists in `zh_CN.yml` and vice versa.
   (`zh_TW.yml` parity is guaranteed by the sync script and need not be reviewed.)
2. **Placeholder index parity**: for every key, the set of `$N` indices
   in en and zh is **identical** (same numeric set, same count). The
   surrounding text may differ for word order.
3. **Pluralization parity**: any plural key (with `0`/`1`/`n` subkeys)
   has the same subkey set in both languages.
4. **Namespace conformance**: every new key sits under one of the
   approved top-level namespaces.
5. **Naming conformance**: every segment is lowerCamelCase; final segment
   names the *thing*, not the element type.
6. **Glossary conformance**: every glossary term in en is rendered with
   the canonical zh translation. Flag deviations.
7. **Style conformance**: buttons are verb phrases; zh punctuation is
   full-width; ellipsis is `…`; no trailing punctuation in button labels.
8. **Placeholder doc comment present** for every key with `$N`, in both
   locales.
9. **No HTML / markdown / interpolated keys** in message strings.
10. **Reuse check**: does an existing `common.*` key already cover this?
    If yes, prefer reusing.
11. **Length sanity**: zh strings used in tight UI (buttons, badges,
    tabs) are not dramatically longer than their en counterparts.
12. **Back-translation spot-check**: pick ~10% of new zh keys and
    silently back-translate to en; flag any that drift in meaning.

Output the review as a structured report:

```
## i18n review

Pass:  <count>
Fail:  <count>
Notes: <count>

### Failures
- <key>: <reason> -> <suggested fix>

### Notes (non-blocking)
- <key>: <observation>
```

## Anti-patterns (never do)

- Hard-coding zh in `.tsx` "just for this one toast".
- Inventing a new top-level namespace without updating this skill.
- Translating brand names, code identifiers, file paths, or HTTP method
  names.
- Embedding line breaks inside a translation string for layout. Use
  separate keys or component composition instead.
- Concatenating translated fragments in code (`t('a') + ' ' + t('b')`).
  Make one key with placeholders.

## Migration-friendliness reminder

These conventions exist so a future move to `react-i18next` is mechanical:

- positional `$1` `$2`            → i18next `{{0}}` `{{1}}` (or named via codemod)
- `0`/`1`/`n` plural maps         → i18next `_zero` / `_one` / `_other` suffixes
- nested dot keys                 → nested JSON (already shaped)
- `t('key', [...])`               → `t('key', [...])` (codemod-friendly)

Do not introduce features that break this property without explicit
project-level approval.

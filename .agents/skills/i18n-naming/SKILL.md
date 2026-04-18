---
name: i18n-naming
description: Cebian project i18n key naming, placeholder, pluralization, file layout, and glossary conventions. MUST be used whenever adding, editing, refactoring, or reviewing any translation key in `locales/*.yml`, any `t(...)` call in source code, or any `__MSG_*__` placeholder in manifest. Also triggers when reviewing diffs that touch i18n files, when proposing new user-facing strings, or when validating translation completeness/consistency between `en.yml`, `zh_CN.yml`, and `zh_TW.yml`.
---

# Cebian i18n Naming & Convention Skill

This skill captures the agreed-upon rules for the Cebian extension's i18n
implementation, built on `@wxt-dev/i18n` with its simple YAML format. All
translation work — both authoring and review — must follow these rules.

## When to apply

- Adding any new `t('...')` call in source.
- Editing any of `locales/en.yml`, `locales/zh_CN.yml`, or `locales/zh_TW.yml`.
- Reviewing a diff that touches i18n.
- Validating that a translation set is complete & consistent.
- Adding a manifest-level localized string (`__MSG_*__`).

## Languages & file layout

Cebian ships **three independently maintained** locales:

- `en` — default (fallback for all non-Chinese users)
- `zh_CN` — Simplified Chinese (Mainland conventions)
- `zh_TW` — Traditional Chinese (Taiwan conventions; also serves HK users
  via Chrome's `zh_TW → zh → default` fallback chain when no `zh_HK` is
  present — we do not ship a separate `zh_HK`)

Source files live at:

```
locales/en.yml
locales/zh_CN.yml
locales/zh_TW.yml
```

All three are **hand-authored** and must respect each language's idiomatic
style. `zh_TW` is NOT a mechanical character conversion of `zh_CN`; word
choice differs (see the Traditional Chinese glossary below).

The WXT module compiles them into
`.output/<browser>/_locales/{en,zh_CN,zh_TW}/messages.json` at build
time. Never edit generated `messages.json` files by hand. Chrome's
`_locales/` directory does not accept a bare `zh` folder, which is why
we ship `zh_CN` and `zh_TW` separately.

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

Authoritative. Any deviation must be discussed and added here. The
`zh_TW` column is **not a character-conversion** of `zh_CN` — Taiwan
usage frequently picks a different word entirely.

| EN                | 简体中文 (zh_CN) | 繁體中文 (zh_TW) | Notes                              |
| ----------------- | ---------------- | ---------------- | ---------------------------------- |
| Cebian            | Cebian           | Cebian           | Brand name, never translated       |
| Extension         | 扩展             | 擴充功能         | TW prefers 擴充功能 over 擴充/擴展  |
| Provider          | 提供商           | 供應商           | TW commonly uses 供應商             |
| Model             | 模型             | 模型             |                                    |
| Skill             | 技能             | 技能             | Translated                         |
| Prompt            | 提示词           | 提示詞           | Translated                         |
| Agent             | 智能体           | 智慧型代理       | TW: 智慧型代理 (avoid bare 代理)   |
| Tool              | 工具             | 工具             |                                    |
| Session / Chat    | 会话 / 对话      | 工作階段 / 對話  | TW: 工作階段 for technical session |
| Thinking          | 思考             | 思考             |                                    |
| Settings          | 设置             | 設定             | TW: 設定 (not 設置)                |
| Sidepanel         | 侧边栏           | 側邊欄           |                                    |
| Token             | Token            | Token            | Keep English                       |
| API Key           | API Key          | API Key          | Keep English                       |
| OAuth             | OAuth            | OAuth            | Keep English                       |
| Sign in / Login   | 登录             | 登入             | TW: 登入 (not 登錄)                |
| Sign out / Logout | 退出             | 登出             | TW: 登出                           |
| Verify            | 验证             | 驗證             |                                    |
| Save              | 保存             | 儲存             | TW: 儲存 (not 保存)                |
| Cancel            | 取消             | 取消             |                                    |
| Delete            | 删除             | 刪除             |                                    |
| Confirm           | 确认             | 確認             |                                    |
| Send              | 发送             | 傳送             | TW: 傳送 (not 發送)                |
| Open              | 打开             | 開啟             | TW: 開啟 (not 打開)                |
| Close             | 关闭             | 關閉             |                                    |
| New chat          | 新对话           | 新對話           |                                    |
| History           | 历史             | 歷史             |                                    |
| Search            | 搜索             | 搜尋             | TW: 搜尋 (not 搜索)                |
| File              | 文件             | 檔案             | TW: 檔案 (not 文件)                |
| Folder            | 文件夹           | 資料夾           | TW: 資料夾                          |
| Network           | 网络             | 網路             | TW: 網路 (not 網絡)                |
| Default           | 默认             | 預設             | TW: 預設 (not 默認)                |
| Information       | 信息             | 資訊             | TW: 資訊 (not 訊息/信息)            |
| Program / Software| 程序 / 软件      | 程式 / 軟體      | TW: 程式, 軟體                      |
| Data              | 数据             | 資料             | TW: 資料 (not 數據)                |

## Style rules

- **Buttons / menu items**: imperative verb phrase, no trailing punctuation.
  - en: `Send`, `Open in new tab`
  - zh_CN: `发送`、`在新标签页打开`
  - zh_TW: `傳送`、`在新分頁開啟`
- **Tooltips / aria-label**: same as button text unless it adds info.
- **Toasts**:
  - Success: short statement, no exclamation. en: `Saved` / zh_CN: `已保存` / zh_TW: `已儲存`
  - Error: state what failed and (when actionable) why.
- **Placeholders / empty states**: hint, not instruction.
  - en: `Search models…`  zh_CN: `搜索模型…`  zh_TW: `搜尋模型…`
- **Sentence punctuation**:
  - en: ASCII punctuation (`. , ! ? : ;`).
  - zh_CN / zh_TW: full-width Chinese punctuation (`。，！？：；`).
  - Ellipsis: single character `…` for all locales, **never** `...`.
- **Length budget**: a zh string used inside a button or badge should not
  exceed the en string by more than ~30% in rendered width.
- **Capitalization (en)**: sentence case for body text and tooltips,
  Title Case only for proper nouns and section headings.

## Authoring workflow

1. Add the key to `locales/en.yml` first.
2. Add the same key to `locales/zh_CN.yml` (Simplified, Mainland style).
3. Add the same key to `locales/zh_TW.yml` (Traditional, Taiwan style).
   This is NOT a character conversion of `zh_CN` — use Taiwan-idiomatic
   word choices per the Traditional Chinese glossary below.
4. Update the call site to `t('your.key')` (or `t('your.key', [arg1, ...])`).
5. If using positional placeholders, document the meaning of each `$N`
   with an inline YAML comment on the preceding line, in all three locales.
6. Run `pnpm compile` (and `pnpm lint:i18n` during the migration phase).

## Review checklist

Run through this list explicitly when reviewing any i18n-touching diff.
Cite each item as pass/fail.

1. **Key parity**: every key in `en.yml`, `zh_CN.yml`, and `zh_TW.yml`
   matches the same set. No orphans in any locale.
2. **Placeholder index parity**: for every key, the set of `$N` indices
   in en, zh_CN, and zh_TW is **identical** (same numeric set, same
   count). The surrounding text may differ for word order.
3. **Pluralization parity**: any plural key (with `0`/`1`/`n` subkeys)
   has the same subkey set in all three languages.
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

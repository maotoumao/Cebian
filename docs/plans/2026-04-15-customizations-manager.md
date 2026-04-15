# Customizations Manager — Prompts & Skills

> **Rename notice (2026-04-15):** All code references have been renamed: `customizations` → `ai-config`, `CustomizationsDialog` → `AIConfigDialog`, dialog ID `'customizations'` → `'ai-config'`, `lib/customizations/` → `lib/ai-config/`, `components/customizations/` → `components/ai-config/`. This doc retains the original naming for historical context.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Customizations Manager to Cebian that allows users to create, edit, and manage **Prompts** (reusable prompt templates) and **Skills** (multi-file agent skill packages following the [agentskills.io specification](https://agentskills.io/specification)). The manager is accessed via a new button in the Header, opens as a Dialog, and uses CodeMirror 6 for editing. All data is persisted in the VFS (`~/.cebian/`). Skills are injected into every user message so the agent can load them on demand. A new `execute_skill_code` tool enables skills to run scripts with declared `chrome.*` API access.

**Architecture:** Two modules (Prompts + Skills) with shared editor infrastructure. Prompts are single `.md` files triggered via `/` command in ChatInput. Skills are multi-file directories following agentskills.io spec, with full frontmatter indexed into every user message's `<agent-config>` block. Skill scripts execute in the background service worker with a sandboxed `chrome.*` API subset based on declared permissions (oil-monkey model).

**Tech Stack:** CodeMirror 6 (Markdown/YAML/JS highlighting, ~150KB gzip, no Web Workers), VFS (IndexedDB via lightning-fs), picomatch (glob matching for `matched-url`), Typebox (tool schemas).

---

## Table of Contents

1. [Concepts & Definitions](#1-concepts--definitions)
2. [VFS Directory Structure](#2-vfs-directory-structure)
3. [File Formats](#3-file-formats)
4. [UI Design](#4-ui-design)
5. [CodeMirror 6 Integration](#5-codemirror-6-integration)
6. [Agent Injection (Skill Index)](#6-agent-injection-skill-index)
7. [execute_skill_code Tool](#7-execute_skill_code-tool)
8. [Prompt `/` Command Panel](#8-prompt--command-panel)
9. [New File Map](#9-new-file-map)
10. [Existing File Changes](#10-existing-file-changes)
11. [Implementation Tasks](#11-implementation-tasks)
12. [Technical Risks](#12-technical-risks)

---

## 1. Concepts & Definitions

### Prompts

Reusable prompt templates stored as single `.md` files. **Not** automatically injected — the user triggers them via `/` command in the chat input. Supports `{{variable}}` template syntax for dynamic content.

| Aspect | Detail |
|--------|--------|
| Storage | `~/.cebian/prompts/*.md` |
| Injection | Manual — user types `/prompt-name` in ChatInput |
| Format | YAML frontmatter (`name`, `description`) + Markdown body with `{{variables}}` |
| Use case | "Translate selected text", "Code review checklist", "Summarize page" |

### Skills

Multi-file agent skill packages that follow the [agentskills.io specification](https://agentskills.io/specification). Each skill is a directory containing at minimum a `SKILL.md` file. All skills are **fully indexed** (frontmatter only) into every user message; the agent decides which to load based on description and URL matching.

| Aspect | Detail |
|--------|--------|
| Storage | `~/.cebian/skills/<skill-name>/` (directory per skill) |
| Injection | Automatic — full index in every message's `<agent-config>` block |
| Format | agentskills.io compliant `SKILL.md` + optional `scripts/`, `references/`, `assets/` |
| Code execution | Via `execute_skill_code` tool with declared `chrome.*` permissions |

### What was removed

- **Instructions** — dropped; the existing "System Prompt" textarea in Settings already covers this use case.
- **SLASH_COMMANDS** — removed from `lib/constants.ts`; replaced by the unified Prompt mechanism.

---

## 2. VFS Directory Structure

Both directories already exist in `DEFAULT_DIRS` ([lib/vfs.ts:23-27](../lib/vfs.ts)). No changes needed.

```
/home/user/.cebian/
├── prompts/                          # Single .md files
│   ├── translate.md
│   └── code-review.md
└── skills/                           # One directory per skill
    ├── web-summary/
    │   ├── SKILL.md                  # Required entry point
    │   ├── scripts/
    │   │   └── extract.js
    │   └── references/
    │       └── format.md
    └── code-explain/
        └── SKILL.md
```

---

## 3. File Formats

### 3.1 Prompt file (`~/.cebian/prompts/*.md`)

```yaml
---
name: translate
description: 翻译选中的文本到目标语言
---
请将以下文本翻译为{{target_language}}：

{{selected_text}}
```

| Field | Required | Rules |
|-------|----------|-------|
| `name` | Yes | Display name + `/` command name |
| `description` | Yes | Shown in command palette and Customizations UI |

The body supports `{{variable}}` template variables (see [section 8](#8-prompt--command-panel) for variable list).

### 3.2 Skill SKILL.md (`~/.cebian/skills/<name>/SKILL.md`)

Fully compliant with [agentskills.io/specification](https://agentskills.io/specification), with Cebian-specific `metadata` extensions:

```yaml
---
name: web-summary
description: >
  Summarize web page content into structured notes. Use when the user asks
  to summarize, digest, or extract key points from the current page.
compatibility: Requires active tab with readable content
metadata:
  matched-url: "https://github.com/**"
  permissions:
    - chrome.bookmarks
    - chrome.history
  author: hongxuanli
  version: "1.0"
allowed-tools: execute_skill_code read_page screenshot
---

## Instructions

1. Call `read_page` with mode "article" to get page content.
2. See [format reference](references/format.md) for output structure.
```

| Field | Required | Rules |
|-------|----------|-------|
| `name` | Yes | 1-64 chars, lowercase `a-z` + digits + hyphens, no leading/trailing/consecutive hyphens. **Must match parent directory name.** |
| `description` | Yes | 1-1024 chars. Describes what the skill does and when to use it. |
| `license` | No | License name or reference |
| `compatibility` | No | Environment requirements, 1-500 chars |
| `metadata` | No | Arbitrary key-value map (see Cebian extensions below) |
| `allowed-tools` | No | Space-separated tool whitelist (v1: parsed but not enforced) |

**Cebian `metadata` extensions:**

| Key | Type | Description |
|-----|------|-------------|
| `matched-url` | `string` (glob) | Glob pattern (picomatch syntax) matching URLs this skill is designed for. Injected into the skill index so the agent can match against the current tab URL. Example: `"https://github.com/**"` |
| `permissions` | `string[]` | Chrome API namespaces the skill's scripts may use. Each entry is a `chrome.*` namespace like `chrome.bookmarks`. See [section 7](#7-execute_skill_code-tool). |

**Name validation rules** (agentskills.io):
- Only Unicode lowercase alphanumeric (`a-z`, `0-9`) and hyphens (`-`)
- Cannot start or end with hyphen
- Cannot contain consecutive hyphens (`--`)
- Must match parent directory name exactly

**Skill directory conventions** (agentskills.io):

```
skill-name/
├── SKILL.md          # Required: metadata + instructions
├── scripts/          # Optional: executable code (JS)
├── references/       # Optional: documentation
├── assets/           # Optional: templates, resources
└── ...               # Any additional files
```

---

## 4. UI Design

### 4.1 Entry Point — Header Button

Insert a new button in `Header.tsx`'s right button group, between "Toggle Theme" and "Settings":

```
┌─ Left ──────────────────── Center ──────────── Right ──────────┐
│ [新对话] [历史]           session title     [主题] [定制] [设置] │
└────────────────────────────────────────────────────────────────┘
```

- **Icon:** `Blocks` (lucide-react)
- **Tooltip:** `"定制"`
- **Style:** `variant="ghost" size="icon-xs"` (matches existing buttons)
- **Action:** `showDialog('customizations', {})`

### 4.2 Dialog — Two-Tab + Two-Column Layout

Reuses the existing Dialog system (`lib/dialog.ts` → `DialogOutlet`). Register as `'customizations'` in the dialog registry.

```
┌──────────────────────────────────────────────────────────────────┐
│  定制管理                                                    ✕  │
├─ [Prompts] [Skills] ────────────────────────────────────────────┤
│                                                                  │
│  ┌─ 列表/树面板 ─────┐  ┌─ 编辑面板 ──────────────────────────┐ │
│  │ w-56              │  │ flex-1                              │ │
│  │                   │  │                                     │ │
│  │ [搜索...]   [+]   │  │  元信息区 (name, description, ...)  │ │
│  │                   │  │  ──────────────────────────────── │ │
│  │ (file list or     │  │                                     │ │
│  │  file tree)       │  │  CodeMirror 6 Editor                │ │
│  │                   │  │  (Markdown + {{variable}} support)  │ │
│  │                   │  │                                     │ │
│  │                   │  │  ──────────────────────────────── │ │
│  │                   │  │              [重置] [保存 ●]        │ │
│  └───────────────────┘  └─────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### 4.3 Prompts Tab

**Left panel — File list:**
- Top bar: search `<Input>` + `[+]` new prompt button
- Flat list of `.md` files from `~/.cebian/prompts/`
- Each item shows: file name + description (truncated)
- Selected item highlighted (`bg-accent`)
- Hover reveals delete button (`Trash2` icon)

**Right panel — Editor:**
- **Meta area:**
  - `名称` — `<Input>` bound to frontmatter `name`
  - `描述` — `<Input>` bound to frontmatter `description`
- **Editor:** CodeMirror 6, language=markdown, `{{variable}}` highlighting + autocomplete enabled
- **Footer:** `[保存]` (primary) + `[重置]` (ghost) + unsaved indicator `●`

**New Prompt flow:**
1. Click `[+]` → create `~/.cebian/prompts/new-prompt.md` with template frontmatter
2. Auto-select new item, focus name input
3. On save → rename file to `{name}.md`

### 4.4 Skills Tab

**Left panel — File tree:**
- Top bar: search + `[+]` new skill button
- Tree view of all skill directories:

```
  ▼ 📁 web-summary
      📄 SKILL.md  ★            ← ★ marks entry file
    ▶ 📁 references
    ▶ 📁 scripts
  ▼ 📁 code-explain
      📄 SKILL.md  ★
```

- Folders expand/collapse
- Right-click/hover on folder → New file, New subfolder, Delete, Rename
- Right-click/hover on file → Delete, Rename
- Click file → load in editor

**Right panel — Editor:**
- **When SKILL.md selected:**
  - Meta area: name (read-only, = folder name), description, matched-url, permissions
  - Editor: SKILL.md body
- **When other file selected:**
  - Meta area: file path only
  - Editor: file content (language auto-detected: `.js`→javascript, `.md`→markdown, `.yaml`→yaml)
- **Footer:** same as Prompts

**New Skill flow:**
1. Click `[+]` → input dialog for skill name (validates agentskills.io naming rules)
2. Create directory + SKILL.md with template:

```yaml
---
name: {user-input}
description: TODO — describe what this skill does and when to use it.
metadata:
  matched-url: "*"
---

## Instructions

(Write your skill instructions here)
```

3. Auto-expand the new folder, select SKILL.md

### 4.5 Narrow-Screen Adaptation (<600px)

When the sidepanel is too narrow for two columns:

- Tab navigation stays (Prompts / Skills)
- List/tree panel goes full width
- Selecting an item → slide-in to editor panel (with `←` back arrow)
- Animation matches existing `SettingsPanel` slide-in style

### 4.6 Future: MCP Tab

The Tab layout naturally supports adding a `[MCP Servers]` tab in the future. MCP server configs would live in `~/.cebian/mcp/`. No pre-work needed now.

---

## 5. CodeMirror 6 Integration

### 5.1 Dependencies to Add

```bash
pnpm add codemirror @codemirror/view @codemirror/state @codemirror/lang-markdown \
  @codemirror/lang-yaml @codemirror/lang-javascript @codemirror/language \
  @codemirror/autocomplete @codemirror/theme-one-dark
```

Bundle size: ~150KB gzip. No Web Workers. No CSP issues.

### 5.2 React Wrapper

**File:** `components/editor/CodeMirrorEditor.tsx`

```typescript
interface CodeMirrorEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: 'markdown' | 'yaml' | 'javascript';
  theme?: 'dark' | 'light';
  placeholder?: string;
  readOnly?: boolean;
  enableTemplateVars?: boolean;  // Enable {{variable}} highlight + autocomplete
  className?: string;
}
```

Behavior:
- Theme sync: listens to Cebian `themePreference` → switches between `oneDark` and default light theme
- Defaults: `wordWrap: 'on'`, `lineNumbers: true`, `fontSize: 13px`
- Loading state: shows `<Spinner />` until EditorView mounts
- Language detection: based on `language` prop or file extension

### 5.3 Template Variable Highlighting

**File:** `components/editor/extensions/template-highlight.ts`

Uses `MatchDecorator` with pattern `/\{\{(\w+)\}\}/g`. Renders matching text as Mark Decorations with styling:
- Light: `bg-blue-100 text-blue-700 rounded px-0.5 font-mono text-[0.9em]`
- Dark: `bg-blue-500/15 text-blue-400 rounded px-0.5 font-mono text-[0.9em]`

### 5.4 Template Variable Autocomplete

**File:** `components/editor/extensions/template-completion.ts`

Custom `CompletionSource`: triggers when user types `{{`. Shows completion panel:

```
{{selected_text}}    页面选中文本
{{page_url}}         当前页面 URL
{{page_title}}       当前页面标题
{{date}}             当前日期
{{clipboard}}        剪贴板内容
```

Auto-appends closing `}}` on selection.

---

## 6. Agent Injection (Skill Index)

### 6.1 Where: `buildStructuredMessage()` in `agent-manager.ts`

Currently the `<agent-config>` block is an empty placeholder:
```typescript
parts.push('<agent-config>\n</agent-config>');
```

Replace with scanned skill index.

### 6.2 Injected Format

```xml
<agent-config>

<skills>
Skills provide specialized domain knowledge and workflows for producing high-quality outputs.
Each skill folder contains tested instructions for specific domains.

BLOCKING REQUIREMENT: When a skill applies to the user's request, you MUST read the SKILL.md
file via fs_read_file IMMEDIATELY as your first action, BEFORE generating any other response.
NEVER just mention or reference a skill without actually reading it first.

How to determine if a skill applies:
1. Review the available skills below and match their descriptions against the user's request
2. Check the matched-url metadata against the current page URL in <context>
3. If any skill's domain overlaps with the task, load that skill immediately

Available skills:
<skill>
<name>web-summary</name>
<description>Summarize web page content into structured notes. Use when the user asks to summarize, digest, or extract key points from the current page.</description>
<metadata>
  matched-url: "https://github.com/**"
  permissions:
    - chrome.bookmarks
  version: "1.0"
</metadata>
<file>~/.cebian/skills/web-summary/SKILL.md</file>
</skill>
<skill>
<name>code-explain</name>
<description>Explain code snippets with detailed annotations.</description>
<file>~/.cebian/skills/code-explain/SKILL.md</file>
</skill>
</skills>

</agent-config>
```

All skills are listed (no pre-filtering). The agent decides which to load based on description + `matched-url` + current request context.

If no skills exist, the block is:
```xml
<agent-config>
</agent-config>
```

### 6.3 Scanner

**File:** `lib/customizations/scanner.ts`

```typescript
interface SkillMeta {
  name: string;
  description: string;
  metadata?: Record<string, unknown>;  // matched-url, permissions, etc.
  compatibility?: string;
  allowedTools?: string;
  filePath: string;  // "~/.cebian/skills/{name}/SKILL.md"
}

/** Scan all skill directories, parse SKILL.md frontmatter only. */
async function scanSkillIndex(): Promise<SkillMeta[]>

/** Build the <skills>...</skills> XML string from scanned index. */
function buildSkillsBlock(metas: SkillMeta[]): string
```

### 6.4 Index Caching & Invalidation

- In-memory cache: `_skillIndex: SkillMeta[] | null`
- TTL: 30 seconds (fallback re-scan)
- **Proactive invalidation:**
  - Customizations Dialog saves a skill file → sends `chrome.runtime.sendMessage({ type: 'invalidate_skill_index' })` to background
  - Background listener clears `_skillIndex = null`
- **VFS hook invalidation:**
  - In `fs-create-file.ts`, `fs-edit-file.ts`, `fs-delete.ts`: after the VFS operation, if the path starts with `~/.cebian/skills/`, clear the skill index cache

### 6.5 Progressive Loading by Agent

```
Agent receives user message with <skills> index
  ↓
Analyzes skill descriptions + matched-url vs current request + tab URL
  ↓
Decides to load "web-summary"
  ↓
fs_read_file("~/.cebian/skills/web-summary/SKILL.md")     ← loads instructions
  ↓
Finds reference to "references/format.md"
  ↓
fs_read_file("~/.cebian/skills/web-summary/references/format.md")
  ↓
Needs to execute code
  ↓
execute_skill_code({ skill: "web-summary", script: "scripts/extract.js", args: {...} })
```

---

## 7. execute_skill_code Tool

### 7.1 Tool Definition

**File:** `lib/tools/execute-skill-code.ts`

```typescript
const ExecuteSkillCodeParameters = Type.Object({
  skill: Type.String({
    description: 'Skill folder name (e.g. "web-summary"). Must match a directory under ~/.cebian/skills/.',
  }),
  script: Type.String({
    description: 'Relative path to JS file within the skill directory (e.g. "scripts/extract.js").',
  }),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: 'Arguments passed to the script, accessible via the `args` variable.',
  })),
});
```

Tool `name`: `execute_skill_code`
Tool `description`:
```
Execute a JavaScript file from a skill's scripts/ directory in the extension background
context. The script runs with chrome.* APIs as declared in the skill's metadata.permissions.
If the skill declares no permissions, only basic JS APIs (fetch, JSON, crypto, etc.) are
available. The script body runs as an async function — use `return` to produce a result.
Arguments are accessible via the `args` variable. Returns JSON-serialized result.
```

### 7.2 Execution Flow

```
agent calls execute_skill_code({ skill, script, args })
  │
  ▼
① Read ~/.cebian/skills/{skill}/SKILL.md from VFS
   → Parse frontmatter → extract metadata.permissions[]
  │
  ▼
② Read ~/.cebian/skills/{skill}/{script} from VFS
   → Get script code string
  │
  ▼
③ Check permission grant status
   → Look up chrome.storage.local key "skillGrants" → Record<skillName, SkillPermissionGrant>
   → If 'always' AND permissions snapshot matches → skip to ⑤
   → Otherwise → ④
  │
  ▼
④ Prompt user confirmation (via interactive tool bridge, same as ask_user)

   ┌─────────────────────────────────────────────┐
   │  🔐 技能代码执行确认                          │
   │                                             │
   │  技能: web-summary                          │
   │  脚本: scripts/extract.js                   │
   │  请求的权限:                                  │
   │    • chrome.bookmarks (读写书签)              │
   │    • chrome.history (读写历史记录)             │
   │                                             │
   │  [拒绝]  [本次允许]  [始终允许此技能]           │
   └─────────────────────────────────────────────┘

   → User denies → return error "User denied permission for skill '{skill}'"
   → User allows → ⑤ (persist if "always")
  │
  ▼
⑤ Build sandbox environment
   → Base APIs: fetch, JSON, console, crypto, TextEncoder, TextDecoder,
     URL, URLSearchParams, atob, btoa, setTimeout, clearTimeout, AbortController
   → For each permission in metadata.permissions:
     "chrome.bookmarks" → sandbox.chrome.bookmarks = chrome.bookmarks
     "chrome.history"   → sandbox.chrome.history   = chrome.history
     (Future chrome.* APIs automatically supported without code changes)
   → Inject args: sandbox.args = args
  │
  ▼
⑥ Execute in background service worker
   const fn = new Function(...sandboxKeys, `return (async () => { ${code} })()`);
   const result = await fn(...sandboxValues);
  │
  ▼
⑦ Return JSON.stringify(result)
```

### 7.3 Permission Grant Storage

```typescript
// Stored in chrome.storage.local under key "skillGrants"
interface SkillPermissionGrant {
  granted: 'always' | 'never';
  permissions: string[];  // Snapshot of permissions at grant time
  grantedAt: number;      // Timestamp
}
type SkillGrants = Record<string, SkillPermissionGrant>;  // keyed by skill name
```

Re-confirmation is required when the skill's `metadata.permissions` changes (snapshot mismatch).

### 7.4 Security Model

| Layer | Measure |
|-------|---------|
| **Declaration** | Permissions must be declared in SKILL.md `metadata.permissions`. Undeclared namespaces are not injected into the sandbox. |
| **Authorization** | First execution requires user confirmation. User can choose "always allow" for persistent authorization. |
| **Runtime sandbox** | `new Function()` receives only the declared `chrome.*` subsets, not the global `chrome` object. |
| **Result boundary** | Return value is JSON-serialized to prevent leaking object references. |
| **Future-proof** | New `chrome.*` APIs automatically available when declared — no executor code changes needed. |

### 7.5 Registration

Add `executeSkillCodeTool` to the `sharedTools` array in `lib/tools/index.ts`.

Add `TOOL_EXECUTE_SKILL_CODE = 'execute_skill_code'` to `lib/types.ts`.

---

## 8. Prompt `/` Command Panel

### 8.1 Current State

`ChatInput.tsx` has a `/` command popup triggered when input starts with `/`. It currently shows hardcoded `SLASH_COMMANDS` from `lib/constants.ts`.

### 8.2 Changes

Remove `SLASH_COMMANDS` from `lib/constants.ts` entirely. Replace with a dynamic list scanned from `~/.cebian/prompts/`:

```
┌──────────────────────────────────────┐
│ 🔤 /translate   翻译选中文本          │  ← from VFS
│ 📝 /code-review 审查代码              │
│ 📄 /summarize   提取并总结当前页面     │
└──────────────────────────────────────┘
```

- Each item shows: icon (📄) + `/name` + description
- List is filtered as user types (e.g. `/tra` → shows `translate`)
- If no prompts exist, show a hint: "暂无 Prompt，前往定制管理创建"

### 8.3 Template Variable Substitution

When user selects a prompt, its body is read from VFS and template variables are replaced:

| Variable | Source | Method |
|----------|--------|--------|
| `{{selected_text}}` | Page selected text | From page context (already gathered) |
| `{{page_url}}` | Active tab URL | `chrome.tabs.query({ active: true, currentWindow: true })` |
| `{{page_title}}` | Active tab title | Same as above |
| `{{date}}` | Current date | `new Date().toLocaleDateString()` |
| `{{clipboard}}` | Clipboard content | `navigator.clipboard.readText()` |

Unknown variables (e.g. `{{custom_var}}`) are left as-is in the output.

The replaced text is inserted into the ChatInput textarea, replacing the `/command` text.

### 8.4 Prompt Scanning

Prompt scanning runs in the **sidepanel** (same extension origin → VFS accessible). Scan `~/.cebian/prompts/` directory, read each `.md` file's frontmatter for `name` + `description`. Cache in component state, re-scan when the `/` popup opens.

---

## 9. New File Map

```
components/
  customizations/
    CustomizationsDialog.tsx       # Dialog container (tabs + two-column + narrow-screen)
    PromptList.tsx                 # Prompts tab — file list panel
    SkillTree.tsx                  # Skills tab — file tree panel
    EditorPanel.tsx                # Shared right-side editor panel (meta + CodeMirror + save/reset)
  editor/
    CodeMirrorEditor.tsx           # CodeMirror 6 React wrapper
    extensions/
      template-highlight.ts       # {{variable}} MatchDecorator highlighting
      template-completion.ts      # {{variable}} autocomplete CompletionSource

lib/
  customizations/
    scanner.ts                     # VFS scanner: prompts + skills index
    frontmatter.ts                 # YAML frontmatter parse/serialize (regex-based, no js-yaml)
    template.ts                    # Template variable replacement engine
    skill-validator.ts             # agentskills.io name validation

lib/tools/
  execute-skill-code.ts            # execute_skill_code tool implementation
```

---

## 10. Existing File Changes

| File | Change |
|------|--------|
| `components/layout/Header.tsx` | Add `onOpenCustomizations` prop. Insert `Blocks` icon button in right button group between theme toggle and settings. |
| `entrypoints/sidepanel/App.tsx` | Pass `onOpenCustomizations={() => showDialog('customizations', {})}` to Header. |
| `components/dialogs/index.ts` | Register `'customizations': CustomizationsDialog` in `dialogRenderers`. |
| `lib/tools/index.ts` | Add `executeSkillCodeTool` to `sharedTools` array. |
| `lib/types.ts` | Add `TOOL_EXECUTE_SKILL_CODE = 'execute_skill_code'` constant. |
| `entrypoints/background/agent-manager.ts` | In `buildStructuredMessage()`: import scanner, call `scanSkillIndex()` + `buildSkillsBlock()`, replace empty `<agent-config>` placeholder. |
| `entrypoints/background/index.ts` | Add listener for `{ type: 'invalidate_skill_index' }` messages. |
| `components/chat/ChatInput.tsx` | Remove `SLASH_COMMANDS` import. Replace hardcoded slash menu with dynamic VFS prompt scan. On prompt selection: read body, replace template variables, insert into textarea. |
| `lib/constants.ts` | Remove `SLASH_COMMANDS` export entirely. |
| `lib/tools/fs-create-file.ts` | After VFS write, if path starts with `~/.cebian/skills/`, send `invalidate_skill_index` message to background. |
| `lib/tools/fs-edit-file.ts` | Same path-based invalidation. |
| `lib/tools/fs-delete.ts` | Same path-based invalidation. |

---

## 11. Implementation Tasks

### Phase 0: Foundation

- [ ] **Task 0.1: Install CodeMirror 6 dependencies**
  ```bash
  pnpm add codemirror @codemirror/view @codemirror/state @codemirror/lang-markdown \
    @codemirror/lang-yaml @codemirror/lang-javascript @codemirror/language \
    @codemirror/autocomplete @codemirror/theme-one-dark
  ```

- [ ] **Task 0.2: Create `lib/customizations/frontmatter.ts`**
  - Implement `parseFrontmatter(content: string): { data: Record<string, any>; body: string }`
  - Implement `serializeFrontmatter(data: Record<string, any>, body: string): string`
  - Uses regex to find `---` delimiters; parses simple YAML (flat keys, arrays, nested maps)
  - No external YAML library dependency

- [ ] **Task 0.3: Create `lib/customizations/skill-validator.ts`**
  - Implement `validateSkillName(name: string): { valid: boolean; error?: string }`
  - Rules: 1-64 chars, lowercase a-z + digits + hyphens, no leading/trailing/consecutive hyphens

- [ ] **Task 0.4: Create `lib/customizations/scanner.ts`**
  - Implement `scanPrompts(): Promise<PromptMeta[]>` — reads `~/.cebian/prompts/`, parses frontmatter
  - Implement `scanSkillIndex(): Promise<SkillMeta[]>` — reads `~/.cebian/skills/*/SKILL.md`, parses frontmatter
  - Implement `buildSkillsBlock(metas: SkillMeta[]): string` — builds XML string
  - Caching: in-memory with 30s TTL + `invalidateSkillIndex()` function

- [ ] **Task 0.5: Create `lib/customizations/template.ts`**
  - Implement `replaceTemplateVars(content: string, vars: Record<string, string>): string`
  - Implement `gatherTemplateVars(): Promise<Record<string, string>>` — collects all built-in variable values

### Phase 1: CodeMirror Editor

- [ ] **Task 1.1: Create `components/editor/extensions/template-highlight.ts`**
  - `MatchDecorator` for `/\{\{(\w+)\}\}/g`
  - Mark Decoration with theme-aware styling

- [ ] **Task 1.2: Create `components/editor/extensions/template-completion.ts`**
  - Custom `CompletionSource` triggered on `{{`
  - Lists 5 built-in variables with descriptions

- [ ] **Task 1.3: Create `components/editor/CodeMirrorEditor.tsx`**
  - React component wrapping CodeMirror 6
  - Props: value, onChange, language, theme, readOnly, enableTemplateVars, placeholder, className
  - Theme sync with Cebian dark/light
  - Loading spinner on first mount

### Phase 2: Customizations Dialog UI

- [ ] **Task 2.1: Create `components/customizations/PromptList.tsx`**
  - Search input + new button
  - File list from VFS scan
  - Selection state management
  - Delete with confirmation

- [ ] **Task 2.2: Create `components/customizations/SkillTree.tsx`**
  - Recursive tree view of skill directories
  - Folder expand/collapse
  - Context actions: new file, new subfolder, rename, delete
  - SKILL.md marked with star icon

- [ ] **Task 2.3: Create `components/customizations/EditorPanel.tsx`**
  - Meta fields (name, description, matched-url, permissions)
  - CodeMirror editor integration
  - Save/Reset buttons with dirty state tracking
  - Adapts meta fields based on active tab (Prompts vs Skills) and selected file (SKILL.md vs other)

- [ ] **Task 2.4: Create `components/customizations/CustomizationsDialog.tsx`**
  - Tab switching (Prompts / Skills)
  - Two-column layout
  - Narrow-screen adaptation (<600px → stacked mode)
  - Wires together PromptList/SkillTree + EditorPanel

### Phase 3: Integration — Header + Dialog Registration

- [ ] **Task 3.1: Modify `components/layout/Header.tsx`**
  - Add `onOpenCustomizations` to `HeaderProps`
  - Insert `Blocks` icon button with tooltip "定制"

- [ ] **Task 3.2: Modify `entrypoints/sidepanel/App.tsx`**
  - Pass `onOpenCustomizations={() => showDialog('customizations', {})}` to Header

- [ ] **Task 3.3: Modify `components/dialogs/index.ts`**
  - Import `CustomizationsDialog`
  - Add `'customizations': CustomizationsDialog` to `dialogRenderers`

### Phase 4: Agent Injection

- [ ] **Task 4.1: Modify `entrypoints/background/agent-manager.ts`**
  - Import `scanSkillIndex`, `buildSkillsBlock` from scanner
  - In `buildStructuredMessage()`: replace empty `<agent-config>` with `buildSkillsBlock(await scanSkillIndex())`

- [ ] **Task 4.2: Modify `entrypoints/background/index.ts`**
  - Add message listener for `{ type: 'invalidate_skill_index' }`
  - Calls `invalidateSkillIndex()` from scanner module

- [ ] **Task 4.3: Add VFS hook invalidation**
  - In `fs-create-file.ts`, `fs-edit-file.ts`, `fs-delete.ts`: after VFS operation, check if path matches `~/.cebian/skills/` and send invalidation message

### Phase 5: execute_skill_code Tool

- [ ] **Task 5.1: Add `TOOL_EXECUTE_SKILL_CODE` to `lib/types.ts`**

- [ ] **Task 5.2: Create `lib/tools/execute-skill-code.ts`**
  - Tool definition with Typebox schema
  - VFS reads (SKILL.md frontmatter + script code)
  - Permission grant checking (chrome.storage.local)
  - User confirmation via interactive tool bridge
  - Sandbox construction (base APIs + declared chrome.* namespaces)
  - `new Function()` execution
  - JSON-serialized return

- [ ] **Task 5.3: Modify `lib/tools/index.ts`**
  - Import and add `executeSkillCodeTool` to `sharedTools`

- [ ] **Task 5.4: Create permission confirmation UI**
  - Register in `ui-registrations.ts` (or use ask_user bridge with structured options)
  - Renders permission list with risk descriptions
  - Three options: Deny / Allow Once / Always Allow

### Phase 6: Prompt `/` Command Panel

- [ ] **Task 6.1: Remove `SLASH_COMMANDS` from `lib/constants.ts`**

- [ ] **Task 6.2: Modify `ChatInput.tsx` — dynamic prompt loading**
  - Remove `SLASH_COMMANDS` import
  - On `/` input: scan `~/.cebian/prompts/` for available prompts
  - Filter list as user types
  - Show "no prompts" hint when empty

- [ ] **Task 6.3: Modify `ChatInput.tsx` — template variable substitution**
  - On prompt selection: read prompt body from VFS
  - Call `gatherTemplateVars()` + `replaceTemplateVars()`
  - Insert result into textarea, replacing `/command` text

### Phase 7: Validation

- [ ] **Task 7.1: Build verification**
  - Run `pnpm run build` and fix any compilation errors

- [ ] **Task 7.2: Code review**
  - Run `code-review` subagent on all changed files

---

## 12. Technical Risks

| Risk | Mitigation |
|------|------------|
| CodeMirror 6 first-mount flash | `<Spinner />` placeholder, fade-in after EditorView creates |
| VFS scan performance with many skills | Only parse frontmatter (stop at second `---`), 30s in-memory cache |
| `new Function()` blocked by CSP in background SW | MV3 extension background SW should allow `unsafe-eval` by default; if not, fall back to offscreen document execution |
| Skill folder rename → name field mismatch | Auto-update SKILL.md frontmatter `name` field on folder rename |
| YAML frontmatter parsing edge cases | Regex-based parser handles flat KV, simple arrays, one-level nested maps; complex YAML not supported (intentional — keeps it lightweight) |
| `{{clipboard}}` permission denied | `navigator.clipboard.readText()` may require focus; if fails, substitute with `(clipboard unavailable)` |
| Too many prompts in `/` panel | Filter list with search input; limit visible items |
| Template variable in skill SKILL.md (user confusion) | Template vars only enabled for Prompts; Skills editor does not highlight `{{...}}` |

# Settings & Model Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a settings page with provider credential management (API Key / OAuth) and a model selector integrated into the chat input area, with all configuration persisted via WXT Storage.

**Architecture:** WXT `storage.defineItem` for typed reactive storage with cross-context sync. Settings page is a slide-in overlay with provider summary + full-screen Dialog for credential management. Model selector is a Popover+Command in ChatInput bottom-left. Thinking effort selector shown conditionally for reasoning models.

**Tech Stack:** React 19, WXT Storage (`#imports`), shadcn/ui (dialog, popover, command, switch, label, spinner), pi-ai (`getProviders`, `getModels`, `getModel`), lucide-react

---

## File Structure

```
lib/
  types.ts                          — EXISTS, no changes
  storage.ts                        — NEW: WXT storage item definitions + types

hooks/
  useStorageItem.ts                 — NEW: React hook wrapping WXT storage.defineItem

components/
  ui/                               — NEW shadcn components added by CLI:
    dialog.tsx
    popover.tsx
    command.tsx
    switch.tsx
    label.tsx
    spinner.tsx

  layout/                           — NEW: global layout components
    Header.tsx                      — MOVE from chat/Header.tsx

  chat/                             — chat-only components
    ChatInput.tsx                   — MODIFY: replace Pick Element area with model + thinking selectors
    Message.tsx                     — NO CHANGES
    ToolCard.tsx                    — NO CHANGES

  settings/                         — all settings-related components
    SettingsPanel.tsx                — MOVE + REWRITE from chat/SettingsPanel.tsx
    model/
      ModelSelector.tsx             — NEW: Popover + Command for model picking
      ThinkingLevelSelector.tsx     — NEW: Popover for thinking effort
    provider/
      ProviderSummary.tsx           — NEW: compact provider card for settings page
      ProviderManagerDialog.tsx     — NEW: full provider management Dialog
      ProviderOAuthItem.tsx         — NEW: single OAuth provider row
      ProviderApiKeyItem.tsx        — NEW: single API Key row with inline save + verify

entrypoints/
  sidepanel/App.tsx                 — MODIFY: migrate theme, update imports
```

---

## Task 0: Reorganize component directory structure

**Files:**
- Move: `components/chat/Header.tsx` → `components/layout/Header.tsx`
- Move: `components/chat/SettingsPanel.tsx` → `components/settings/SettingsPanel.tsx`
- Modify: `entrypoints/sidepanel/App.tsx` (update imports)

- [ ] **Step 1: Move files and update all imports**

Move Header.tsx to `components/layout/Header.tsx`. Move SettingsPanel.tsx to `components/settings/SettingsPanel.tsx`. Update imports in `App.tsx`.

- [ ] **Step 2: Compile check**

```bash
pnpm compile
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "refactor: reorganize component directory structure"
```

---

## Task 1: Install shadcn components

**Files:**
- Create: `components/ui/dialog.tsx`, `components/ui/popover.tsx`, `components/ui/command.tsx`, `components/ui/switch.tsx`, `components/ui/label.tsx`, `components/ui/spinner.tsx`

- [ ] **Step 1: Install all 6 components via CLI**

```bash
pnpm dlx shadcn@latest add dialog popover command switch label spinner
```

- [ ] **Step 2: Read and review each new file in `components/ui/`**

Verify imports resolve correctly, icon library matches `lucide-react`, no broken dependencies.

- [ ] **Step 3: Compile check**

```bash
pnpm compile
```

Expected: clean pass, no errors.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add shadcn dialog, popover, command, switch, label, spinner"
```

---

## Task 2: WXT Storage layer

**Files:**
- Create: `lib/storage.ts`
- Create: `hooks/useStorageItem.ts`
- Modify: `entrypoints/sidepanel/App.tsx`

- [ ] **Step 1: Create `lib/storage.ts`**

```typescript
import { storage } from '#imports';

// ─── Provider credential types ───

export interface ApiKeyCredential {
  authType: 'apiKey';
  apiKey: string;
  verified: boolean;
}

export interface OAuthCredential {
  authType: 'oauth';
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  verified: boolean;
}

export type ProviderCredential = ApiKeyCredential | OAuthCredential;

export type ProviderCredentials = Record<string, ProviderCredential>;

// ─── Active model ───

export interface ActiveModel {
  provider: string;
  modelId: string;
}

// ─── Thinking level ───

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high';

// ─── Settings ───

export interface ProxySettings {
  enabled: boolean;
  url: string;
}

export interface BehaviorSettings {
  confirmBeforeExec: boolean;
  streaming: boolean;
  backgroundPersist: boolean;
}

export interface CebianSettings {
  proxy: ProxySettings;
  behavior: BehaviorSettings;
}

// ─── Storage items (WXT defineItem) ───

export const providerCredentials = storage.defineItem<ProviderCredentials>(
  'local:providerCredentials',
  { fallback: {} },
);

export const activeModel = storage.defineItem<ActiveModel | null>(
  'local:activeModel',
  { fallback: null },
);

export const thinkingLevel = storage.defineItem<ThinkingLevel>(
  'local:thinkingLevel',
  { fallback: 'medium' },
);

export const themePreference = storage.defineItem<'dark' | 'light'>(
  'local:theme',
  { fallback: 'dark' },
);

export const cebianSettings = storage.defineItem<CebianSettings>(
  'local:settings',
  {
    fallback: {
      proxy: { enabled: false, url: '' },
      behavior: { confirmBeforeExec: true, streaming: true, backgroundPersist: true },
    },
  },
);
```

- [ ] **Step 2: Create `hooks/useStorageItem.ts`**

```typescript
import { useState, useEffect, useCallback } from 'react';

type WxtStorageItem<T> = {
  getValue(): Promise<T>;
  setValue(value: T): Promise<void>;
  watch(cb: (newValue: T, oldValue: T) => void): () => void;
};

export function useStorageItem<T>(item: WxtStorageItem<T>, fallback: T): [T, (value: T) => Promise<void>] {
  const [value, setValueState] = useState<T>(fallback);

  useEffect(() => {
    item.getValue().then(setValueState);
    const unwatch = item.watch((newVal) => setValueState(newVal));
    return unwatch;
  }, [item]);

  const setValue = useCallback(
    async (newValue: T) => {
      setValueState(newValue);
      await item.setValue(newValue);
    },
    [item],
  );

  return [value, setValue];
}
```

- [ ] **Step 3: Migrate theme to WXT storage in App.tsx**

Replace `localStorage.getItem('cebian-theme')` / `localStorage.setItem(...)` with `useStorageItem(themePreference, 'dark')`. Remove the `localStorage` calls entirely. Keep the `useEffect` that applies `data-theme` to `document.documentElement`.

- [ ] **Step 4: Compile check**

```bash
pnpm compile
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: add WXT storage layer and migrate theme persistence"
```

---

## Task 3: Model Selector

**Files:**
- Create: `components/settings/ModelSelector.tsx`
- Create: `components/settings/ThinkingLevelSelector.tsx`

- [ ] **Step 1: Create `components/settings/ModelSelector.tsx`**

Popover trigger (compact button showing current model name + ▾) → opens Popover → contains Command with:
- `CommandInput` for search/filter
- `CommandGroup` per provider (label = provider name), only for providers with verified credentials
- `CommandItem` per model, showing model name + ✓ if selected
- `CommandSeparator` between groups
- Bottom `CommandItem` with ⚙️ icon: "前往设置添加更多提供商"

Uses `getProviders()` and `getModels(provider)` from `@mariozechner/pi-ai` to build the list. Filters against `providerCredentials` storage item — only shows providers where `credential.verified === true`.

Each `CommandItem` displays:
- Model name (e.g. "Claude Sonnet 4")
- Subtle metadata: context window, reasoning badge if `model.reasoning`

Props:
```typescript
interface ModelSelectorProps {
  activeModel: ActiveModel | null;
  configuredProviders: ProviderCredentials;
  onSelect: (provider: string, modelId: string) => void;
  onOpenSettings: () => void;
}
```

- [ ] **Step 2: Create `components/settings/ThinkingLevelSelector.tsx`**

Small Popover trigger (shows "思考: 中 ▾") → opens with 5 items:
- 关闭 → `'off'`
- 最小 → `'minimal'`
- 低 → `'low'`
- 中 → `'medium'`
- 高 → `'high'`

Current level gets ✓. Only rendered when `model.reasoning === true`.

Props:
```typescript
interface ThinkingLevelSelectorProps {
  level: ThinkingLevel;
  onSelect: (level: ThinkingLevel) => void;
}
```

- [ ] **Step 3: Compile check**

```bash
pnpm compile
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add ModelSelector and ThinkingLevelSelector"
```

---

## Task 4: Integrate selectors into ChatInput

**Files:**
- Modify: `components/chat/ChatInput.tsx`

- [ ] **Step 1: Add model + thinking selectors to ChatInput bottom row**

In the bottom row `<div className="flex items-center justify-between px-2 pb-2">`, replace the left side (`Pick Element` button) with:

```tsx
<div className="flex items-center gap-1.5">
  <ModelSelector
    activeModel={currentModel}
    configuredProviders={providers}
    onSelect={handleModelSelect}
    onOpenSettings={onOpenSettings}
  />
  {isReasoningModel && (
    <ThinkingLevelSelector
      level={currentThinkingLevel}
      onSelect={handleThinkingSelect}
    />
  )}
</div>
```

Read state from WXT storage via `useStorageItem`:
```typescript
const [currentModel, setCurrentModel] = useStorageItem(activeModel, null);
const [currentThinkingLevel, setCurrentThinkingLevel] = useStorageItem(thinkingLevel, 'medium');
const [providers] = useStorageItem(providerCredentials, {});
```

Determine `isReasoningModel` by calling `getModel(currentModel.provider, currentModel.modelId)?.reasoning`.

Add `onOpenSettings` to `ChatInputProps` so the "前往设置" link can bubble up.

- [ ] **Step 2: Compile check + visual verification**

```bash
pnpm compile
```

Load extension, verify: model button shows in bottom-left, popover opens, thinking selector appears for reasoning models.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: integrate model and thinking selectors into ChatInput"
```

---

## Task 5: Provider credential components

**Files:**
- Create: `components/settings/ProviderApiKeyItem.tsx`
- Create: `components/settings/ProviderOAuthItem.tsx`

- [ ] **Step 1: Create `components/settings/ProviderApiKeyItem.tsx`**

A self-contained row for one API Key provider:

```
│ Anthropic                                │
│ Claude 系列模型                           │
│ ┌─────────────────────────┐              │
│ │ sk-ant-•••••••          │  [保存]      │
│ └─────────────────────────┘              │
│ ✓ 已连接 · 3 个模型                      │
```

Behavior:
- Input field: `type="password"` by default, toggle to reveal via eye icon
- [保存] button: on click →
  1. Button shows `<Spinner />` + "验证中..."
  2. Call `complete(getModel(provider, firstModelId), { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] }, { apiKey })` as connectivity test
  3. Success → save via `providerCredentials.setValue(...)` with `verified: true`, show "✓ 已连接 · N 个模型" in green
  4. Failure → show "✕ 连接失败: error message" in red, don't persist
- If already saved: input prefilled with masked key, status shown

Props:
```typescript
interface ProviderApiKeyItemProps {
  provider: string;
  label: string;
  description: string;
  credential?: ApiKeyCredential;
  onSave: (credential: ApiKeyCredential) => void;
}
```

Uses shadcn: `Input`, `Button`, `Spinner`, `Label`.

- [ ] **Step 2: Create `components/settings/ProviderOAuthItem.tsx`**

A self-contained row for one OAuth provider:

```
│ GitHub Copilot                           │
│ 使用 Copilot 订阅访问 GPT/Claude         │
│ ✓ 已登录                    [退出登录]   │
```

Or if not logged in:
```
│ GitHub Copilot                           │
│ 使用 Copilot 订阅访问 GPT/Claude         │
│                        [使用账号登录]     │
```

Note: `@mariozechner/pi-ai/oauth` login functions (`loginGitHubCopilot`, etc.) are Node.js only. For browser extension, the OAuth flow must run in the background script. For now:
- [登录] button dispatches `chrome.runtime.sendMessage({ type: 'oauth-login', provider })` to the background script
- Background script will handle the actual OAuth flow (future task, not in this plan)
- Show a "OAuth 登录需要在后续版本中实现" placeholder if background handler not ready

Props:
```typescript
interface ProviderOAuthItemProps {
  provider: string;
  label: string;
  description: string;
  credential?: OAuthCredential;
  onLogin: () => void;
  onLogout: () => void;
}
```

- [ ] **Step 3: Compile check**

```bash
pnpm compile
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add ProviderApiKeyItem and ProviderOAuthItem"
```

---

## Task 6: Provider Manager Dialog

**Files:**
- Create: `components/settings/ProviderManagerDialog.tsx`

- [ ] **Step 1: Create the Dialog**

Full Dialog (shadcn `Dialog` + `DialogContent` + `DialogHeader` + `DialogTitle`). Title: "管理 AI 提供商". Scrollable body with two main sections:

**Section: "通过账号登录"**

Renders `ProviderOAuthItem` for each OAuth provider. Fixed list:
```typescript
const OAUTH_PROVIDERS = [
  { provider: 'github-copilot', label: 'GitHub Copilot', description: '使用 Copilot 订阅访问 GPT/Claude' },
  { provider: 'openai-codex', label: 'OpenAI Codex', description: '使用 ChatGPT Plus/Pro 订阅' },
  { provider: 'google-gemini-cli', label: 'Google Gemini', description: 'Google Cloud OAuth 登录' },
];
```

**Section: "通过 API Key"**

Renders `ProviderApiKeyItem` for each API Key provider. Fixed list:
```typescript
const APIKEY_PROVIDERS = [
  { provider: 'anthropic', label: 'Anthropic', description: 'Claude 系列模型' },
  { provider: 'openai', label: 'OpenAI', description: 'GPT-4o, o1, o3 系列' },
  { provider: 'google', label: 'Google Gemini', description: 'Gemini 2.5 Flash/Pro' },
  { provider: 'xai', label: 'xAI', description: 'Grok 系列' },
  { provider: 'groq', label: 'Groq', description: '高速推理' },
  { provider: 'openrouter', label: 'OpenRouter', description: '多模型聚合' },
  { provider: 'mistral', label: 'Mistral', description: 'Mistral/Mixtral 系列' },
];
```

Reads credentials from `useStorageItem(providerCredentials, {})`. Each item's `onSave` calls `providerCredentials.setValue(...)` to merge the new credential.

Props:
```typescript
interface ProviderManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

- [ ] **Step 2: Compile check**

```bash
pnpm compile
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add ProviderManagerDialog"
```

---

## Task 7: Rewrite SettingsPanel

**Files:**
- Create: `components/settings/provider/ProviderSummary.tsx`
- Rewrite: `components/settings/SettingsPanel.tsx`

- [ ] **Step 1: Create `components/settings/ProviderSummary.tsx`**

Compact card for one configured provider:

```
│ ◉ Anthropic       ✓ 已连接   │
│   API Key · 3 个模型可用      │
```

Uses `getModels(provider)` to count available models.

Props:
```typescript
interface ProviderSummaryProps {
  provider: string;
  credential: ProviderCredential;
}
```

- [ ] **Step 2: Rewrite `components/chat/SettingsPanel.tsx`**

Keep the existing slide-in overlay pattern (`absolute inset-0`, `translate-x` transition). Replace body with 4 sections:

**Section 1: AI 提供商**
- If no verified providers: empty state icon (🔑) + "尚未配置任何 AI 提供商" + [配置提供商] button
- If has verified providers: up to 5 `ProviderSummary` cards + [管理提供商...] button
- Both buttons open `ProviderManagerDialog`

**Section 2: 网络**
- CORS 代理: shadcn `Switch` + `Label`
- 代理地址: shadcn `Input` (shown when proxy enabled)
- Read/write via `useStorageItem(cebianSettings, DEFAULT_SETTINGS)`

**Section 3: 行为**
- 执行前确认: `Switch` + `Label` + description
- 流式输出: `Switch` + `Label` + description
- 后台任务持久化: `Switch` + `Label` + description
- All bound to `cebianSettings` storage item

**Section 4: 关于**
- "Cebian v0.1.0"
- "AI 浏览器侧边栏助手"
- Links: GitHub · MIT License · 反馈

Delete the old `ToggleSwitch` component at the bottom — replaced by shadcn `Switch`.

Section separators use shadcn `Separator`. Section labels use `text-xs text-muted-foreground font-medium tracking-wide uppercase`.

- [ ] **Step 3: Compile check**

```bash
pnpm compile
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: rewrite SettingsPanel with provider management"
```

---

## Task 8: End-to-end wiring and verification

**Files:**
- Modify: `entrypoints/sidepanel/App.tsx` (wire ProviderManagerDialog + pass onOpenSettings)

- [ ] **Step 1: Wire up App.tsx**

- Add `ProviderManagerDialog` state (`providerDialogOpen`) in App.tsx
- Pass `onOpenSettings` down through to ChatInput (either via prop drilling or by having ChatInput open settings directly)
- Ensure the "前往设置" link in ModelSelector opens the settings panel, and "配置提供商" / "管理提供商..." buttons in SettingsPanel open the ProviderManagerDialog

- [ ] **Step 2: Full flow manual test**

Checklist:
1. Open settings → verify 4 sections render correctly
2. Click "配置提供商" → Dialog opens with OAuth + API Key groups
3. Enter API key for a provider → click [保存] → verify spinner → verify ✓/✕ status
4. Close dialog → verify ProviderSummary card appears in settings
5. Close settings → verify ModelSelector in ChatInput shows models from configured provider
6. Select a model → close/reopen sidepanel → verify selection persisted
7. Select a reasoning model → verify thinking level selector appears
8. Toggle behavior switches → close/reopen settings → verify persisted
9. Toggle theme → verify persisted across sidepanel reopen

- [ ] **Step 3: Compile check**

```bash
pnpm compile
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: settings and model selector integration complete"
```

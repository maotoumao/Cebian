# Message End UI + Unified Clipboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the end of an assistant turn unmistakable (streaming cursor + meta row + copy button) and consolidate all clipboard usage into one robust helper.

**Architecture:** A small `lib/clipboard.ts` provides `copyText` / `readText` with feature-detection, secure-context fallback, and consistent toast feedback. `AgentMessage` gains a streaming cursor while live, and an end-meta row (model · usage · cost · duration · copy) once the turn completes. Existing `navigator.clipboard.*` call sites are migrated.

**Tech Stack:** React 19, shadcn/ui (`Button`, `Tooltip`), `lucide-react`, `sonner` toasts (already in repo).

---

## File Structure

### New files
- `lib/clipboard.ts` — `copyText(text, opts?) → Promise<boolean>`, `readText() → Promise<string>` with fallback + uniform error handling.
- `components/chat/MessageMetaRow.tsx` — bottom-of-bubble row: model · `↑in ↓out` · cost · duration · copy button.
- `components/chat/CopyButton.tsx` — icon-only `Copy → Check` swap, 1.5 s revert, idempotent.

### Modified files
- `components/chat/Message.tsx` — `AgentMessage` always renders the streaming cursor at the *end* of streamed content while `isStreaming`; renders `MessageMetaRow` once `!isStreaming`.
- `components/settings/provider/ProviderOAuthItem.tsx` — replace bare `navigator.clipboard.writeText` with `copyText`.
- `lib/ai-config/template.ts` — replace `navigator.clipboard.readText()` with `readText()`.
- `entrypoints/sidepanel/pages/chat/index.tsx` — pass `usage` / `durationMs` props to `AgentMessage` (data already present on the last assistant `Message`).
- `locales/en.yml`, `locales/zh_CN.yml`, `locales/zh_TW.yml` — `chat.message.copy`, `chat.message.copied`, `chat.message.copyFailed`, `chat.message.tokensIn`, `chat.message.tokensOut`, `chat.message.cost`, `chat.message.duration`.

---

## Task 1: Unified Clipboard Helper

**Files:**
- Create: `lib/clipboard.ts`
- Modify: `components/settings/provider/ProviderOAuthItem.tsx`
- Modify: `lib/ai-config/template.ts`

- [ ] **Step 1: Create `lib/clipboard.ts`**

```ts
// lib/clipboard.ts
import { toast } from 'sonner';
import { t } from '@/lib/i18n';

interface CopyOptions {
  /** Suppress success/failure toasts; caller handles its own feedback. */
  silent?: boolean;
}

export async function copyText(text: string, opts: CopyOptions = {}): Promise<boolean> {
  const ok = await tryCopy(text);
  if (!opts.silent) {
    if (ok) toast.success(t('common.copied'));
    else toast.error(t('common.copyFailed'));
  }
  return ok;
}

export async function readText(): Promise<string> {
  try {
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
  } catch {
    /* fall through */
  }
  return '';
}

async function tryCopy(text: string): Promise<boolean> {
  // Modern API — works in secure contexts when document is focused.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  // Legacy fallback: hidden textarea + execCommand('copy')
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
```

Notes for implementer:
- **Never log `text`**: clipboard data may include OAuth codes / API keys.
- The legacy fallback is necessary because the side panel can lose focus during stream rendering, causing `writeText` to reject in some Chrome versions.

- [ ] **Step 2: Add i18n keys**

In `locales/en.yml` (mirror in `zh_CN.yml`, `zh_TW.yml`):
```yaml
common:
  copied: Copied
  copyFailed: Copy failed
```
Use existing `i18n-naming` skill conventions (camelCase keys, no trailing punctuation).

- [ ] **Step 3: Migrate `ProviderOAuthItem.tsx`**

Replace:
```ts
navigator.clipboard.writeText(code);
```
with:
```ts
import { copyText } from '@/lib/clipboard';
// ...
await copyText(code); // toast handled by helper
```
Remove any now-redundant local toast calls.

- [ ] **Step 4: Migrate `lib/ai-config/template.ts`**

Replace:
```ts
vars.clipboard = await navigator.clipboard.readText();
```
with:
```ts
import { readText } from '@/lib/clipboard';
// ...
vars.clipboard = await readText();
```
Drop the surrounding try/catch (helper already swallows + returns `''`).

- [ ] **Step 5: Run `pnpm check`** — confirm types + i18n lint pass.

- [ ] **Step 6: Manual smoke test** — copy a device code from the OAuth provider dialog, verify toast appears.

- [ ] **Step 7: Commit** — `feat(clipboard): unify clipboard access via lib/clipboard.ts`

---

## Task 2: Streaming Cursor (Always-On During Stream)

**Files:**
- Modify: `components/chat/Message.tsx`

Currently the cursor only shows when `children` is empty. We want it visible **at the end of streamed content** for the entire stream — that's the strongest "still typing" signal.

- [ ] **Step 1: Refactor `AgentMessage` to always emit trailing cursor while streaming**

In `components/chat/Message.tsx`, change:
```tsx
<div className="text-[0.9rem] leading-relaxed space-y-3">
  {children}
  {isStreaming && !children && (
    <span className="inline-block w-1.5 h-4 bg-primary animate-pulse rounded-sm align-text-bottom" />
  )}
</div>
```
to:
```tsx
<div className="text-[0.9rem] leading-relaxed space-y-3">
  {children}
  {isStreaming && (
    <span
      aria-hidden
      className="inline-block w-1.5 h-4 bg-primary animate-pulse rounded-sm align-text-bottom ml-0.5"
    />
  )}
</div>
```

Implementer notes:
- The cursor lives *after* `children` so it visually trails the last token.
- `aria-hidden` keeps screen readers quiet.
- Removal happens automatically when `isStreaming` flips to false on `message_end`.

- [ ] **Step 2: Verify behavior** — start a chat, observe the cursor appears immediately, persists through streaming, vanishes on completion.

- [ ] **Step 3: Commit** — `feat(chat): always show streaming cursor at end of agent reply`

---

## Task 3: Copy Button (`CopyButton` component)

**Files:**
- Create: `components/chat/CopyButton.tsx`
- Modify: `locales/en.yml`, `locales/zh_CN.yml`, `locales/zh_TW.yml`

- [ ] **Step 1: Add i18n keys**

```yaml
chat:
  message:
    copy: Copy
    copied: Copied
```

- [ ] **Step 2: Implement `CopyButton`**

```tsx
// components/chat/CopyButton.tsx
import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { copyText } from '@/lib/clipboard';
import { t } from '@/lib/i18n';

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function onClick() {
    const ok = await copyText(text, { silent: true });
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={onClick}
          aria-label={copied ? t('chat.message.copied') : t('chat.message.copy')}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? t('chat.message.copied') : t('chat.message.copy')}</TooltipContent>
    </Tooltip>
  );
}
```

Implementer notes:
- `silent: true` because the icon swap *is* the feedback; a toast on top would be noisy.
- Icon size `3.5` (≈14 px) reads well at 7 × 7 button.

- [ ] **Step 3: Commit** — `feat(chat): add CopyButton component`

---

## Task 4: Message End Meta Row

**Files:**
- Create: `components/chat/MessageMetaRow.tsx`
- Modify: `components/chat/Message.tsx` (extend `AgentMessage` props + render)
- Modify: `entrypoints/sidepanel/pages/chat/index.tsx` (pass usage + duration)
- Modify: i18n files for meta labels

The `Message` (pi-ai) on `assistant` role already carries `usage` (`input`, `output`, `cost.total`) and a `timestamp` we can subtract from a captured `agent_start` timestamp (or `message_update` start) to compute duration. We will keep this client-side: track the start time when `isStreaming` flips on; freeze duration when it flips off.

- [ ] **Step 1: Add i18n keys**

```yaml
chat:
  message:
    tokensInOut: '↑{{input}} ↓{{output}}'
    cost: '${{cost}}'
    durationSeconds: '{{seconds}}s'
```

- [ ] **Step 2: Implement `MessageMetaRow`**

```tsx
// components/chat/MessageMetaRow.tsx
import { CopyButton } from './CopyButton';
import { t } from '@/lib/i18n';

export interface MessageMetaProps {
  modelLabel?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
  copyText: string;
}

function formatTokens(n?: number): string {
  if (n == null) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function MessageMetaRow({
  modelLabel, inputTokens, outputTokens, costUsd, durationMs, copyText,
}: MessageMetaProps) {
  const parts: string[] = [];
  if (modelLabel) parts.push(modelLabel);
  if (inputTokens != null || outputTokens != null) {
    parts.push(t('chat.message.tokensInOut', {
      input: formatTokens(inputTokens),
      output: formatTokens(outputTokens),
    }));
  }
  if (costUsd != null && costUsd > 0) parts.push(t('chat.message.cost', { cost: costUsd.toFixed(4) }));
  if (durationMs != null) parts.push(t('chat.message.durationSeconds', { seconds: (durationMs / 1000).toFixed(1) }));

  return (
    <div className="mt-2 flex items-center justify-between gap-2 text-[0.7rem] text-muted-foreground/80 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
      <span className="font-mono">{parts.join(' · ')}</span>
      <CopyButton text={copyText} />
    </div>
  );
}
```

Implementer notes:
- Whole row is `opacity-0` and fades in on parent `group-hover` — matches "non-intrusive when reading, discoverable on hover".
- Force-visible variant (always on) can be added later if user feedback warrants it.

- [ ] **Step 3: Extend `AgentMessage` to render the row**

Update `AgentMessage` props:
```tsx
export function AgentMessage({
  children, isStreaming, showHeader = true, meta, copyText,
}: {
  children?: ReactNode;
  isStreaming?: boolean;
  showHeader?: boolean;
  meta?: Omit<MessageMetaProps, 'copyText'>;
  copyText?: string;
}) {
```
Wrap the existing return in a `group` class to enable group-hover, and append the meta row when not streaming and `copyText` is truthy:
```tsx
<div className={`group self-start w-full ${showHeader ? '' : '-mt-1'}`}>
  {/* …existing children + cursor… */}
  {!isStreaming && copyText && (
    <MessageMetaRow {...(meta ?? {})} copyText={copyText} />
  )}
</div>
```

- [ ] **Step 4: Compute duration + extract copy text in chat page**

In `entrypoints/sidepanel/pages/chat/index.tsx` where `AgentMessage` is rendered:

1. When the chat page sees `agent_start`, record `Date.now()` keyed by sessionId-or-turn (a simple `useRef<number | null>`) — set it when `isRunning` flips true with no current value.
2. When `isRunning` flips false, capture `durationMs = Date.now() - startedAt` and store it on the rendered turn (a `useRef<Map<messageIndex, number>>` keyed by the assistant message position; reset on session change).
3. Extract `copyText` by joining all text content blocks of the assistant `Message` (skip thinking, tool calls).

A new helper in `lib/message-helpers.ts`:
```ts
export function extractAssistantPlainText(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n')
    .trim();
}
```

Pass props:
```tsx
<AgentMessage
  isStreaming={isThisTurnStreaming}
  meta={{
    modelLabel: msg.model,
    inputTokens: msg.usage?.input,
    outputTokens: msg.usage?.output,
    costUsd: msg.usage?.cost?.total,
    durationMs: durationFor(msgIndex),
  }}
  copyText={extractAssistantPlainText(msg)}
>
  {/* existing children */}
</AgentMessage>
```

- [ ] **Step 5: `pnpm check`** — types + i18n lint.

- [ ] **Step 6: Manual smoke test**
  - Stream a reply: cursor visible, meta row hidden.
  - Reply finishes: cursor disappears, hover the bubble, meta row fades in, copy button shown.
  - Click copy: icon swaps to ✔, tooltip says "Copied", reverts after 1.5 s.
  - Verify clipboard contents = the markdown plain text (no thinking, no tool JSON).
  - Verify behavior on a turn with no usage info (e.g. canceled mid-stream): row still shows what it has, gracefully drops missing parts.

- [ ] **Step 7: Commit** — `feat(chat): show end-of-turn meta row with copy button`

---

## Task 5: Cleanup + Docs

- [ ] **Step 1: Search for stragglers** — `grep_search "navigator.clipboard"` should now return zero matches outside `lib/clipboard.ts`.
- [ ] **Step 2: Run full `pnpm check` + manual extension reload + smoke through new chat / oauth copy / prompt template clipboard variable.**
- [ ] **Step 3: Final commit** — `chore(clipboard): remove direct navigator.clipboard usage`.

---

## Out of scope (intentionally)

- "Regenerate" button (deferred — requires truncating subsequent messages).
- "Copy as plain text" vs "Copy as markdown" toggle (current copy = markdown, sufficient for v1).
- Click-to-play completion sound (mentioned in earlier discussion; opt-in setting, deferred).
- Token-budget progress ring on `ChatInput` (covered by the context-compaction plan).

# Context Compaction & Token Budget (PROPOSAL — DO NOT EXECUTE YET)

> **Status:** PROPOSAL — design ideas captured below, but the original "in-place rewrite of `agent.state.messages`" approach has a **P0 design flaw** (see "Open issues" below) and the implementation is **blocked on the SessionContext refactor** (see [`2026-04-19-memory-and-tool-context-refactor-PROPOSAL.md`](./2026-04-19-memory-and-tool-context-refactor-PROPOSAL.md)). Do **not** start implementing without explicit re-approval and a revised plan.
>
> **Why deferred:** Naive compaction would silently destroy the user's visible chat history and make the future "regenerate last message" feature impossible to implement cleanly. Both problems are best solved by introducing a `displayMessages` vs `modelMessages` split, which in turn belongs in the SessionContext refactor rather than bolted onto `agent-manager.ts`.

---

## Open issues that must be resolved before this becomes a real plan

### 1. UI history loss (P0)

Today `agent.state.messages` is the **single source of truth** — it feeds the model, drives the UI broadcast, and is what `ThrottledSessionWriter` persists to Dexie. The original Tier-A/Tier-B sketch below mutates that array in place. Net effect after a compaction:

- Side panel re-renders showing only the summary stub + tail messages.
- Dexie row gets overwritten with the same shortened array.
- Original conversation is **unrecoverable**.

**Required mitigation: dual-track messages.**

- `displayMessages: AgentMessage[]` — append + truncate-from-tail only. Always shown in the UI, always persisted whole.
- `modelMessages: AgentMessage[]` — what the agent actually sends to the LLM. Compaction rewrites this; UI never reads it.
- `compactionMarkers: CompactionMarker[]` — `{ id, startDisplayIdx, endDisplayIdx, summary, tier, tokensBefore, tokensAfter, at }`. UI inserts an inline "📦 Compacted N messages" divider between display messages at each marker's range; "expand" reads `displayMessages.slice(start, end)` (zero data duplication).
- New `ServerMessage` types: `compaction_start` / `compaction_end` so the UI can show a "Compacting context…" banner.
- `SessionRecord` schema bump to v2 with migration `modelMessages = messages` for existing rows.

### 2. Regenerate / edit-and-resend (forward compatibility)

Future feature: regenerate the last assistant message, or edit the last user message and resubmit. With single-track in-place compaction this is **impossible** for any turn that's been folded into a summary — the originals are gone.

With dual-track it's straightforward:

1. `displayMessages` is ground truth → find the truncation index N.
2. `displayMessages = displayMessages.slice(0, N)`.
3. Drop any `compactionMarkers` whose `endDisplayIdx > N`.
4. Reset `modelMessages = displayMessages` (let the next prompt's natural compaction trigger handle it again — simplest correct behaviour).
5. Tear down the old `Agent` instance and recreate it from the truncated `modelMessages` (the existing model-switch path in `agent-manager.ts` already does this).

So `displayMessages` semantics is **append + truncate-tail**, not strictly append-only.

### 3. Coupling to SessionContext refactor

Adding `displayMessages`, `modelMessages`, `compactionMarkers`, `compactionInProgress`, `tokenUsage`, `pendingCompactionPromise`, `truncateAt()`, `regenerateLast()` directly onto `ManagedSession` in `agent-manager.ts` will balloon that file past 1000 lines and leave tools (which only see `SessionToolContext`) unable to read or trigger compaction. These belong on the new `SessionContext` proposed in the memory/refactor PROPOSAL.

**Therefore the SessionContext refactor is a hard prerequisite for this work.**

---

## Original design sketch (kept for reference; needs rewrite under dual-track)

**Goal:** Replace the current naive sliding window with a two-tier compaction strategy (tool-result clearing + summary compaction), an error-driven fallback that auto-recovers from `context_length_exceeded` responses, a runtime-discovered context-window estimate, and a token-budget indicator on `ChatInput`.

**Architecture:** Compaction logic lives behind `transformContext` (already a pi-agent-core hook called only at turn boundaries — guaranteeing we never split a tool round). A pure module (`lib/compaction.ts`) computes the transform; another (`lib/context-overflow-detector.ts`) classifies provider errors. `agent.ts` wires both together with a 1-shot retry on overflow. Background tracks observed `prompt_tokens` per `provider/modelId` to discover the real context window for un-declared providers. The side panel renders a small ring + popover near the send button.

**Tech Stack:** pi-agent-core (`transformContext`, `Agent.subscribe`), pi-ai usage stats, WXT storage, React.

---

## Design Constants

```ts
export const COMPACTION_DEFAULTS = {
  toolClearThresholdRatio: 0.5,          // Tier-A trigger
  summaryThresholdRatio: 0.7,             // Tier-B trigger
  keepRecentTokenRatio: 0.4,              // budget for "keep verbatim" zone
  minProtectedTurns: 3,                   // hard floor — never drop these
  fallbackContextWindow: 32000,           // when model declares none and no observation yet
  observationCeilingMultiplier: 1.1,      // padding around observed max prompt_tokens
  retryOnOverflow: 1,                     // attempts after triggering aggressive compaction
};
```

All exposed as configurable via `cebianContextSettings` (Task 6).

---

## File Structure

### New files
- `lib/context-overflow-detector.ts` — `isContextOverflowError(err): boolean` (3-layer matcher).
- `lib/compaction.ts` — pure functions: `clearOldToolResults(messages, opts)`, `summarizeIfNeeded(messages, opts) → Promise<{ messages, summary? }>`, `compactNow(...)` orchestrator.
- `lib/observed-context-window.ts` — small storage-backed registry: `record(key, promptTokens)`, `get(key) → number | undefined`.
- `components/chat/ContextUsageRing.tsx` — SVG ring + popover.
- `components/settings/sections/ContextSection.tsx` — settings UI for thresholds.

### Modified files
- `lib/agent.ts` — replace `transformContext` with new pipeline; wrap LLM call with overflow-retry helper; subscribe to record `prompt_tokens` after each `message_end`.
- `lib/storage.ts` — add `cebianContextSettings` defineItem.
- `lib/protocol.ts` — extend `agent_end` / `message_end` to include `usageSnapshot` (latest known input/output tokens) so side panel can render the ring without re-reading DB.
- `lib/db.ts` — `SessionRecord` gains `compactedSummary?: string` and `lastPromptTokens?: number`.
- `entrypoints/background/agent-manager.ts` — emit `usageSnapshot` on broadcast; persist `compactedSummary`.
- `entrypoints/sidepanel/pages/chat/index.tsx` (or wherever `ChatInput` is composed) — pass `tokenUsage` to `ContextUsageRing` next to send button.
- `components/chat/ChatInput.tsx` — slot for the ring (right of textarea, left of send button).
- `components/settings/SectionNav.tsx` — add Context entry.
- `locales/en.yml`, `locales/zh_CN.yml`, `locales/zh_TW.yml` — keys under `chat.context`, `settings.context`.

---

## Task 1: Context-overflow Error Detector

**Files:**
- Create: `lib/context-overflow-detector.ts`

- [ ] **Step 1: Implement detector**

```ts
// lib/context-overflow-detector.ts

const OVERFLOW_PATTERNS: RegExp[] = [
  /maximum context length/i,
  /context.{0,10}(length|window).{0,20}(exceed|too)/i,
  /prompt is too long/i,
  /input.{0,15}(length|tokens?).{0,30}exceed/i,
  /too many tokens/i,
  /request.{0,15}(too large|payload size)/i,
  /reduce the length/i,
  /string.{0,10}above.{0,10}max.{0,10}length/i,
];

const OVERFLOW_CODES = new Set([
  'context_length_exceeded',
  'string_above_max_length',
]);

export function isContextOverflowError(err: unknown): boolean {
  if (!err) return false;
  const e = err as any;

  // Layer 1 — structured error code (OpenAI family)
  const code: string | undefined =
    e?.code ?? e?.error?.code ?? e?.response?.data?.error?.code;
  if (code && OVERFLOW_CODES.has(code)) return true;

  // Layer 2 — gate on HTTP status before pattern matching
  const status: number | undefined =
    e?.status ?? e?.statusCode ?? e?.response?.status;
  if (status != null && status !== 400 && status !== 413) return false;

  // Layer 3 — message regex fallback
  const msg = String(
    e?.message ?? e?.error?.message ?? e?.response?.data?.error?.message ?? ''
  ).toLowerCase();
  return OVERFLOW_PATTERNS.some(p => p.test(msg));
}
```

- [ ] **Step 2: Smoke unit-test mentally** — feed a few synthetic error shapes (OpenAI 400, Anthropic 400, generic 500) and verify classifications match design table.
- [ ] **Step 3: Commit** — `feat(compaction): add context-overflow error detector`.

---

## Task 2: Observed Context Window Registry

**Files:**
- Create: `lib/observed-context-window.ts`
- Modify: `lib/storage.ts`

- [ ] **Step 1: Add storage item**

```ts
// lib/storage.ts
export const observedContextWindows = storage.defineItem<Record<string, number>>(
  'local:observedContextWindows',
  { fallback: {} },
);
```

- [ ] **Step 2: Implement registry**

```ts
// lib/observed-context-window.ts
import { observedContextWindows } from '@/lib/storage';

const CEILING_MULT = 1.1;
const cache = new Map<string, number>();
let loaded = false;

async function ensureLoaded() {
  if (loaded) return;
  const stored = await observedContextWindows.getValue();
  for (const [k, v] of Object.entries(stored)) cache.set(k, v);
  loaded = true;
}

export async function recordPromptTokens(key: string, tokens: number): Promise<void> {
  await ensureLoaded();
  const cur = cache.get(key) ?? 0;
  if (tokens <= cur) return;
  cache.set(key, tokens);
  await observedContextWindows.setValue(Object.fromEntries(cache));
}

export async function getObservedWindow(key: string): Promise<number | undefined> {
  await ensureLoaded();
  const v = cache.get(key);
  return v ? Math.round(v * CEILING_MULT) : undefined;
}
```

`key` format: `${provider}/${modelId}` — same as `managed.modelKey` in `agent-manager.ts`.

- [ ] **Step 3: Hook recording in `agent-manager.ts`**

In `handleAgentEvent` `message_end` case, after broadcasting:
```ts
const last = event.message;
if ('role' in last && last.role === 'assistant' && last.usage?.input != null) {
  await recordPromptTokens(managed.modelKey, last.usage.input);
}
```

- [ ] **Step 4: Commit** — `feat(compaction): record observed prompt-token highs per model`.

---

## Task 3: Settings Storage + Section UI

**Files:**
- Modify: `lib/storage.ts`
- Create: `components/settings/sections/ContextSection.tsx`
- Modify: `components/settings/SectionNav.tsx`
- Modify: i18n locale files

- [ ] **Step 1: Storage schema**

```ts
// lib/storage.ts
export interface CebianContextSettings {
  autoCompact: boolean;
  toolClearThresholdRatio: number;       // 0.3 – 0.8
  summaryThresholdRatio: number;         // 0.5 – 0.9
  keepRecentTokenRatio: number;          // 0.2 – 0.6
  minProtectedTurns: number;             // 1 – 10
  fallbackContextWindow: number;         // user fallback when no info
  compactionModel?: { provider: string; modelId: string }; // optional cheap model
}

export const cebianContextSettings = storage.defineItem<CebianContextSettings>(
  'local:cebianContextSettings',
  {
    fallback: {
      autoCompact: true,
      toolClearThresholdRatio: 0.5,
      summaryThresholdRatio: 0.7,
      keepRecentTokenRatio: 0.4,
      minProtectedTurns: 3,
      fallbackContextWindow: 32000,
    },
  },
);
```

- [ ] **Step 2: Section UI**

Build `ContextSection.tsx` (use `useStorageItem`) with these controls:
- `Switch` — Auto compaction.
- `Slider` 30–80% — Tool-result clearing threshold.
- `Slider` 50–90% — Summary compaction threshold.
- `Slider` 20–60% — Keep-recent token ratio.
- `Number input` 1–10 — Min protected turns.
- `Number input` (with units) — Fallback context window.
- `ModelSelector` (reuse existing) — Compaction model (optional).
- `Button` — "Compact current session now" (sends a new client message — see Task 5).

Visually mirror `AdvancedSection.tsx` for styling consistency.

- [ ] **Step 3: Wire SectionNav entry + i18n keys.**

- [ ] **Step 4: Commit** — `feat(settings): context management section`.

---

## Task 4: Pure Compaction Module

**Files:**
- Create: `lib/compaction.ts`

- [ ] **Step 1: Tier-A — clear old tool results**

```ts
// lib/compaction.ts
import type { AgentMessage } from '@mariozechner/pi-agent-core';

export interface CompactionOpts {
  contextWindow: number;
  settings: CebianContextSettings;
  /** `(msgs) => approxTokenCount` — see helpers below. */
  estimateTokens: (m: AgentMessage[]) => number;
}

/**
 * Replace tool-result content in messages older than the most recent N user turns
 * with a one-line stub. Idempotent.
 */
export function clearOldToolResults(
  messages: AgentMessage[],
  opts: { keepRecentTurns: number },
): AgentMessage[] {
  const turnStarts = findUserTurnStartIndices(messages);
  const keepFromIdx = turnStarts[turnStarts.length - opts.keepRecentTurns] ?? 0;

  return messages.map((m, i) => {
    if (i >= keepFromIdx) return m;
    if ('role' in m && m.role === 'toolResult') {
      // Replace content with stub; preserve toolCallId / toolName so the trace stays consistent.
      return {
        ...m,
        content: [
          { type: 'text', text: `[Tool result cleared · ${(m as any).toolName ?? 'tool'} · re-call the tool if you need this]` },
        ],
      } as AgentMessage;
    }
    return m;
  });
}
```

- [ ] **Step 2: Tier-B — summarize older history**

```ts
export interface SummarizeArgs {
  messages: AgentMessage[];
  contextWindow: number;
  keepRecentTokenRatio: number;
  minProtectedTurns: number;
  estimateTokens: (m: AgentMessage[]) => number;
  /** Returns the summary text. */
  invokeSummarizer: (toCompact: AgentMessage[]) => Promise<string>;
}

export async function summarizeIfNeeded(args: SummarizeArgs): Promise<{
  messages: AgentMessage[];
  summary?: string;
}> {
  const turnStarts = findUserTurnStartIndices(args.messages);
  if (turnStarts.length < args.minProtectedTurns + 1) {
    return { messages: args.messages };
  }

  // Walk backwards from end, accumulating tokens, until we exceed the budget
  // OR we hit the minProtectedTurns floor — whichever yields more "kept" turns.
  const budget = args.contextWindow * args.keepRecentTokenRatio;
  let cutTurnIdx = turnStarts.length - args.minProtectedTurns; // hard floor
  for (let t = turnStarts.length - 1; t >= 0; t--) {
    const slice = args.messages.slice(turnStarts[t]);
    if (args.estimateTokens(slice) > budget) {
      cutTurnIdx = Math.min(cutTurnIdx, t + 1);
      break;
    }
  }
  cutTurnIdx = Math.min(cutTurnIdx, turnStarts.length - args.minProtectedTurns);
  if (cutTurnIdx <= 0) return { messages: args.messages };

  const cutMsgIdx = turnStarts[cutTurnIdx];
  const toCompact = args.messages.slice(0, cutMsgIdx);
  const kept = args.messages.slice(cutMsgIdx);

  const summary = await args.invokeSummarizer(toCompact);
  const summaryMsg: AgentMessage = {
    role: 'user',
    content: [{ type: 'text', text: `<context-summary>\n${summary}\n</context-summary>` }],
    timestamp: Date.now(),
    // marker so UI can render compaction badge
    meta: { compactionMarker: true, replacedCount: toCompact.length } as any,
  } as AgentMessage;

  return { messages: [summaryMsg, ...kept], summary };
}
```

- [ ] **Step 3: Helpers**

```ts
export function estimateTokensRough(messages: AgentMessage[]): number {
  // Char-to-token heuristic: ~3.5 latin / ~1.5 CJK; we average to 2.5
  let chars = 0;
  for (const m of messages) {
    const c = (m as any).content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) {
      for (const block of c) if (block?.text) chars += block.text.length;
    }
  }
  return Math.ceil(chars / 2.5);
}

export function findUserTurnStartIndices(messages: AgentMessage[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as any;
    if (m.role === 'user' && !m.meta?.compactionMarker) out.push(i);
  }
  return out;
}
```

- [ ] **Step 4: Summarizer prompt template**

```ts
export const SUMMARIZER_SYSTEM_PROMPT = `You compress conversation history. Output a structured summary preserving:
- The user's original goal and current sub-goal
- Key decisions made and their rationale
- Files / URLs / selectors referenced (with full paths)
- Completed work (concise bullets)
- Outstanding work or blockers
- User preferences expressed during the session
Be precise. Skip pleasantries. Use markdown bullets. Hard cap: 1500 words.`;
```

- [ ] **Step 5: Commit** — `feat(compaction): pure compaction module`.

---

## Task 5: Wire Compaction Into Agent + Overflow Retry

**Files:**
- Modify: `lib/agent.ts`
- Modify: `entrypoints/background/agent-manager.ts` (handle "compact now" client message)
- Modify: `lib/protocol.ts` (`compact_now` client message)

- [ ] **Step 1: Replace `transformContext` in `lib/agent.ts`**

Pseudocode:
```ts
transformContext: async (msgs) => {
  if (!settings.autoCompact) return msgs.slice(-maxRounds * 3); // legacy fallback
  const cw = await resolveContextWindow(model, settings);
  const tokens = estimateTokensRough(msgs);

  // Tier A
  let next = tokens / cw > settings.toolClearThresholdRatio
    ? clearOldToolResults(msgs, { keepRecentTurns: settings.minProtectedTurns })
    : msgs;

  // Tier B
  if (estimateTokensRough(next) / cw > settings.summaryThresholdRatio) {
    const r = await summarizeIfNeeded({ /* … */ });
    next = r.messages;
    if (r.summary) await sessionStore.updateSummary(currentSessionId, r.summary);
  }

  return next;
},
```

`resolveContextWindow(model, settings)`:
1. `model.contextWindow` if declared.
2. Else `await getObservedWindow(`${provider}/${modelId}`)`.
3. Else `settings.fallbackContextWindow`.

- [ ] **Step 2: Overflow-retry wrapper**

Pi-agent-core invokes the model internally; the cleanest hook we have is `transformContext` (which can throw to abort). Instead, wrap at the agent-manager `prompt()` level:

```ts
async function runWithOverflowRetry(managed, fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isContextOverflowError(err)) throw err;
    // Aggressive compaction — bypass thresholds, force both tiers.
    managed.agent.state.messages = await compactNow(managed.agent.state.messages, {
      forceAggressive: true,
    });
    return await fn();
  }
}
```

Implementer notes:
- Pi-agent-core's `Agent.prompt()` returns a Promise that rejects on LLM error — confirm by reading `node_modules/@mariozechner/pi-agent-core` before implementing; if it swallows errors, we need to subscribe to `agent_end` and check for an `error` event instead.
- Limit to `settings.retryOnOverflow` (default 1) attempts.

- [ ] **Step 3: `compact_now` protocol message**

```ts
// lib/protocol.ts
| { type: 'compact_now'; sessionId: string }
```

`agent-manager.compactNow(sessionId)` runs Tier A + Tier B unconditionally and broadcasts `message_end` with the new message list so the UI re-renders.

- [ ] **Step 4: Commit** — `feat(compaction): wire compaction into agent + overflow retry`.

---

## Task 6: Compaction Marker UI

**Files:**
- Modify: `components/chat/Message.tsx` (add `CompactionMarker` component)
- Modify: chat page render loop to detect `meta.compactionMarker` and render the marker instead of a normal user bubble.
- i18n keys.

- [ ] **Step 1: `CompactionMarker` component**

```tsx
// in Message.tsx
export function CompactionMarker({ replacedCount, summaryPreview }: { replacedCount: number; summaryPreview: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="self-stretch my-2 rounded-md border border-border/60 bg-muted/30 text-[0.75rem] text-muted-foreground">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-3 py-1.5">
        <span>📋</span>
        <span>{t('chat.compaction.summary', { count: replacedCount })}</span>
      </button>
      {open && (
        <pre className="px-3 py-2 whitespace-pre-wrap text-foreground/80 border-t border-border/40">{summaryPreview}</pre>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Integrate render** in `entrypoints/sidepanel/pages/chat/index.tsx` — before normal user bubble, check `meta?.compactionMarker`.
- [ ] **Step 3: Commit** — `feat(chat): render compaction marker`.

---

## Task 7: Context Usage Ring on ChatInput

**Files:**
- Create: `components/chat/ContextUsageRing.tsx`
- Modify: `components/chat/ChatInput.tsx` (slot the ring next to send button)
- Modify: chat page to compute + pass `usedTokens` and `contextWindow` (uses session's `lastPromptTokens` + resolved window)

- [ ] **Step 1: Implement ring**

```tsx
// components/chat/ContextUsageRing.tsx
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';

interface Props {
  usedTokens: number | undefined;       // undefined → hide
  contextWindow: number | undefined;    // undefined → hide
  summaryThreshold: number;             // 0..1
  onCompact?: () => void;
}

export function ContextUsageRing({ usedTokens, contextWindow, summaryThreshold, onCompact }: Props) {
  if (!usedTokens || !contextWindow) return null;
  const pct = Math.min(1, usedTokens / contextWindow);
  const colorClass =
    pct < 0.6 ? 'stroke-muted-foreground'
    : pct < 0.8 ? 'stroke-yellow-500'
    : pct < 0.95 ? 'stroke-orange-500'
    : 'stroke-destructive animate-pulse';
  const r = 6, c = 2 * Math.PI * r;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="size-5 grid place-items-center" aria-label={t('chat.context.ringAriaLabel')}>
          <svg viewBox="0 0 16 16" className="size-4">
            <circle cx="8" cy="8" r={r} className="stroke-border" strokeWidth="2" fill="none" />
            <circle
              cx="8" cy="8" r={r}
              className={colorClass}
              strokeWidth="2" fill="none" strokeLinecap="round"
              strokeDasharray={c} strokeDashoffset={c * (1 - pct)}
              transform="rotate(-90 8 8)"
            />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 text-xs" side="top" align="end">
        <div className="font-mono">
          {Math.round(usedTokens / 100) / 10}k / {Math.round(contextWindow / 1000)}k tokens ({Math.round(pct * 100)}%)
        </div>
        <div className="mt-1 text-muted-foreground">
          {t('chat.context.autoCompactAt', { pct: Math.round(summaryThreshold * 100) })}
        </div>
        {onCompact && (
          <Button size="sm" variant="outline" className="mt-2 w-full" onClick={onCompact}>
            {t('chat.context.compactNow')}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Slot in `ChatInput`**

Place the ring just before the existing send button. Read `usedTokens` from a new chat-page hook that:
- subscribes to last `agent_end` for the active session,
- pulls `usage.input` from the latest assistant message,
- resolves `contextWindow` via the same logic as `lib/agent.ts`.

- [ ] **Step 3: Wire `Compact now` action** — calls the new `compact_now` port message from Task 5.

- [ ] **Step 4: Commit** — `feat(chat): context usage ring with manual compact`.

---

## Task 8: Verification & Cleanup

- [ ] **Step 1:** `pnpm check` — types + i18n lint pass.
- [ ] **Step 2: Manual smoke**
  - Long-running conversation: trigger Tier A near 50%, Tier B near 70%, observe marker appears.
  - Force overflow: configure a model with `contextWindow: 4096` via custom-providers, send a long history → verify auto-retry succeeds with marker.
  - Custom provider w/o `contextWindow`: confirm the ring stays hidden initially, appears after first turn (observed window kicks in), then settings-fallback path.
  - Click "Compact now" from ring popover and from settings — both trigger compaction.
- [ ] **Step 3: Commit** — `chore(compaction): verification pass`.

---

## Out of scope

- `/compact` slash command (deferred — manual button covers the use case).
- Live re-injection of host memory on tab switch (not relevant to compaction).
- Per-tool result-size truncation (orthogonal optimization; can be added later inside `clearOldToolResults`).

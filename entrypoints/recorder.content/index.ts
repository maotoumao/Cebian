// Programmatically-injected content script for the user-action recorder.
//
// Lifecycle:
//   1. Background calls `chrome.scripting.executeScript({ files: [...] })`
//      — this script runs once, registers an idempotent stop function on
//      `window.__cebianRecorderStop`, then waits for an `init` message.
//   2. Background sends `{ kind: 'cebian_recorder', type: 'init', startedAt,
//      tabId }`. On receipt we update `initState`, attach interaction
//      listeners (Task 5), and start the MutationObserver (Task 6).
//   3. On `final_flush` we drain the mutation buffer; on `__cebianRecorderStop()`
//      (called by background's detach) we tear everything down.
//
// Defensive properties:
//   - Cleanup is managed by an explicit `cleanups` stack drained in reverse on
//     stop(), plus `ctx.onInvalidated(stop)` to catch extension reload mid-
//     recording. Raw browser APIs (chrome.runtime.onMessage, MutationObserver,
//     and Task 5's window-level interaction listeners) do NOT get free
//     invalidation safety from WXT — they're all torn down via the stack.
//   - The script never mutates page DOM (no overlays, no class additions).
//   - Re-injection is idempotent: a previous instance's stop function is
//     called before we install ourselves, preventing duplicate listeners.
//   - All `chrome.runtime.sendMessage` calls are try/caught: if the
//     background is gone (extension reloaded), we self-destruct.

import {
  buildSelector,
  describeNode,
  getLabel,
  getRole,
  getViewportArea,
  isSemanticContainer,
  meetsAreaThreshold,
  rectMeetsAreaThreshold,
} from '@/lib/recorder/dom-utils';
import {
  INPUT_DEBOUNCE_MS,
  INPUT_VALUE_MAX,
  MUTATION_AREA_RATIO,
  MUTATION_FLUSH_FORCE_MS,
  MUTATION_FLUSH_IDLE_MS,
  MUTATION_RAW_BUFFER_MAX,
  SCROLL_THROTTLE_MS,
  SEMANTIC_ROLES,
  SEMANTIC_TAGS,
} from '@/lib/recorder/constants';
import {
  type RecorderControlMessage,
  RECORDER_MSG_KIND,
  isRecorderRuntimeMessage,
} from '@/lib/recorder/protocol';
import type { MutationChange, RecordedEventWithoutBase } from '@/lib/recorder/types';

declare global {
  interface Window {
    /** Set by this script while it is armed; called by the background's
     *  `detach` flow (or by a re-injection of this script) to tear down. */
    __cebianRecorderStop?: () => void;
  }
}

export default defineContentScript({
  // No `matches` — this script is registered at runtime and injected via
  // `chrome.scripting.executeScript({ files: [...] })`. Empty matches plus
  // `registration: 'runtime'` keeps it out of the manifest.
  matches: [],
  registration: 'runtime',
  runAt: 'document_idle',
  world: 'ISOLATED',

  main(ctx) {
    // Idempotency: if a previous instance is still armed (e.g. the user
    // toggled recording off+on quickly, or the background re-injected),
    // stop it before we install ourselves.
    if (typeof window.__cebianRecorderStop === 'function') {
      try { window.__cebianRecorderStop(); }
      catch (err) { console.warn('[cebian-recorder] previous stop threw:', err); }
    }

    let initState: { tabId: number; startedAt: number } | null = null;
    let stopped = false;
    /** Set during the cleanup drain so the cleanup callbacks themselves
     *  may bypass the `stopped` early-return in send(). Without this, the
     *  per-element input-debounce flushers and the trailing scroll flush
     *  would no-op (because we set `stopped = true` before draining), and
     *  the user's last typed value / pending scroll deltas would be lost. */
    let draining = false;
    /** Cleanups run in reverse insertion order on stop(). Adding via this
     *  helper guarantees we never leak a listener even if a later install
     *  step throws. */
    const cleanups: Array<() => void> = [];
    function onCleanup(fn: () => void): void {
      cleanups.push(fn);
    }

    function stop(): void {
      if (stopped) return;
      stopped = true;
      draining = true;
      // Drain in reverse so observers are stopped before their dependent
      // structures (e.g. the WeakRef map) are dropped. Errors in one
      // cleanup must not block the rest.
      for (let i = cleanups.length - 1; i >= 0; i--) {
        try { cleanups[i](); }
        catch (err) { console.warn('[cebian-recorder] cleanup threw:', err); }
      }
      cleanups.length = 0;
      draining = false;
      if (window.__cebianRecorderStop === stop) {
        delete window.__cebianRecorderStop;
      }
    }
    window.__cebianRecorderStop = stop;
    // WXT context invalidation (extension reload, tab navigation, etc.)
    // also tears us down so we don't leak listeners into a dead context.
    ctx.onInvalidated(stop);

    // ─── Outbound messaging ─────────────────────────────────────────────

    function send(event: RecordedEventWithoutBase): void {
      if (!initState) return;
      // Allow drain-time emissions through even after `stopped` flips, so
      // the stop() drain can land last input/scroll values.
      if (stopped && !draining) return;
      try {
        chrome.runtime.sendMessage({
          kind: RECORDER_MSG_KIND,
          type: 'event',
          event,
        });
      } catch (err) {
        // Extension context invalidated, background not ready, or the
        // background side rejected the message. Self-destruct so we don't
        // keep firing into the void.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Extension context invalidated') || msg.includes('Could not establish connection')) {
          stop();
        } else {
          console.warn('[cebian-recorder] send failed:', err);
        }
      }
    }

    /** Convenience wrapper that fills the per-event tabId/url so individual
     *  emit sites stay focused on the variant-specific fields. The
     *  distributive `extends` here preserves discriminated-union variants
     *  through Omit (a plain `Omit<RecordedEventWithoutBase, ...>` would
     *  collapse the variants and reject the kind-specific fields). */
    type EmitArg = RecordedEventWithoutBase extends infer T
      ? T extends RecordedEventWithoutBase ? Omit<T, 'tabId' | 'url'> : never
      : never;
    function emit(partial: EmitArg): void {
      if (!initState) return;
      send({
        ...partial,
        tabId: initState.tabId,
        url: location.href,
      } as RecordedEventWithoutBase);
    }

    // ─── Inbound control messages ───────────────────────────────────────

    function onMessage(msg: unknown): void {
      if (stopped) return;
      if (!isRecorderRuntimeMessage(msg)) return;
      // Only control messages should arrive here; events flow the other way.
      if (msg.type !== 'init' && msg.type !== 'final_flush') return;
      const ctl = msg as RecorderControlMessage;
      if (ctl.type === 'init') {
        // Late re-init (re-attach after navigation, or a recovery path that
        // re-sends init to the same instance) is permitted. We install
        // listeners only once per content-script instance. If you ever
        // re-init with a new `startedAt`, be aware that the already-
        // installed listeners keep using the original initState values
        // via this closure (which is fine: initState is updated in-place
        // below, so subsequent emits use the new values).
        initState = { tabId: ctl.tabId, startedAt: ctl.startedAt };
        if (interactionsArmed) return;
        installInteractionListeners();
        installMutationObserver();
        // First-init gate: subsequent inits skip the install branch above.
        interactionsArmed = true;
      } else if (ctl.type === 'final_flush') {
        flushMutations();
      }
    }
    chrome.runtime.onMessage.addListener(onMessage);
    onCleanup(() => chrome.runtime.onMessage.removeListener(onMessage));

    // ─── Interaction listeners ─────────────────────────────────────────

    let interactionsArmed = false;

    /** Selector matching elements that are "the thing the user clicked",
     *  even when the click landed on a descendant icon/span. We walk up
     *  via `closest()` to find the nearest match before recording. */
    const ACTIONABLE_SELECTOR =
      'button, a, [role="button"], [role="link"], [role="menuitem"], ' +
      '[role="tab"], [role="option"], input, select, textarea, label, ' +
      '[contenteditable="true"], [contenteditable=""]';

    /** Keys recorded even without modifiers \u2014 navigation & control keys
     *  that imply intent the `input` event can't capture. */
    const RECORDED_KEYS: ReadonlySet<string> = new Set([
      'Enter', 'Escape', 'Tab', 'Backspace', 'Delete',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'PageUp', 'PageDown', 'Home', 'End',
    ]);

    /** Modifier keys themselves \u2014 e.g. pressing Shift alone fires keydown
     *  with `key === 'Shift'`; that's noise, skip it. */
    const MODIFIER_KEY_NAMES: ReadonlySet<string> = new Set([
      'Shift', 'Control', 'Alt', 'Meta', 'AltGraph',
    ]);

    /** Per-element debounce timers for `input`. Stored in a WeakMap so
     *  detached inputs don't pin themselves alive. Each tick replaces the
     *  previous pending emission for that element. */
    const inputDebounceTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

    /** Last per-input emitted value, keyed by element. Used to suppress
     *  duplicate emissions when the debounced value matches the previous
     *  one (e.g. user types then deletes back to the same string). */
    const inputLastValue = new WeakMap<Element, string>();

    /** Scroll aggregation across the throttle window. */
    let scrollAccumDx = 0;
    let scrollAccumDy = 0;
    let lastScrollX = window.scrollX;
    let lastScrollY = window.scrollY;
    let scrollFlushTimer: ReturnType<typeof setTimeout> | null = null;

    function installInteractionListeners(): void {
      // All listeners are window-level capture-phase so we see events the
      // page may stopPropagation() on, and `passive: true` so we never
      // block the page even by accident (we don't preventDefault anywhere).
      const opts: AddEventListenerOptions = { capture: true, passive: true };

      window.addEventListener('click', onClick, opts);
      onCleanup(() => window.removeEventListener('click', onClick, opts));

      window.addEventListener('input', onInput, opts);
      onCleanup(() => window.removeEventListener('input', onInput, opts));

      window.addEventListener('change', onChange, opts);
      onCleanup(() => window.removeEventListener('change', onChange, opts));

      window.addEventListener('submit', onSubmit, opts);
      onCleanup(() => window.removeEventListener('submit', onSubmit, opts));

      window.addEventListener('keydown', onKeyDown, opts);
      onCleanup(() => window.removeEventListener('keydown', onKeyDown, opts));

      window.addEventListener('scroll', onScroll, opts);
      onCleanup(() => window.removeEventListener('scroll', onScroll, opts));

      // Drain any in-flight per-input debounces on stop so the last typed
      // value is recorded.
      onCleanup(() => {
        // Only the latest flusher per element runs. (Earlier flushers for
        // the same element were superseded by clearTimeout in onInput.)
        for (const fn of pendingInputFlushes.values()) {
          try { fn(); } catch { /* ignore */ }
        }
        pendingInputFlushes.clear();
        if (scrollFlushTimer) {
          clearTimeout(scrollFlushTimer);
          scrollFlushTimer = null;
        }
        // Always attempt a trailing scroll flush; flushScroll() is a no-op
        // when accumulators are zero.
        flushScroll();
      });
    }

    /** Latest pending input flusher per element. Bounded by the number of
     *  distinct fields the user typed into; superseded entries replace the
     *  previous one rather than accumulate. Used by stop() to drain the
     *  last typed values before tearing down. */
    const pendingInputFlushes = new Map<Element, () => void>();

    // ─── Common helpers ────────────────────────────────────────────────

    /** Build the `target` descriptor used by every interaction event. */
    function describeTarget(el: Element): {
      selector: string;
      tag: string;
      role?: string;
      label?: string;
      type?: string;
    } {
      const tag = el.tagName.toLowerCase();
      const out: ReturnType<typeof describeTarget> = {
        selector: buildSelector(el),
        tag,
      };
      const role = getRole(el);
      if (role) out.role = role;
      const label = getLabel(el);
      if (label) out.label = label;
      if (el instanceof HTMLInputElement) out.type = el.type;
      return out;
    }

    function modifiersFromEvent(
      e: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean },
    ): Array<'ctrl' | 'shift' | 'alt' | 'meta'> | undefined {
      const mods: Array<'ctrl' | 'shift' | 'alt' | 'meta'> = [];
      if (e.ctrlKey) mods.push('ctrl');
      if (e.shiftKey) mods.push('shift');
      if (e.altKey) mods.push('alt');
      if (e.metaKey) mods.push('meta');
      return mods.length ? mods : undefined;
    }

    function emitInteraction(args: {
      action: 'click' | 'input' | 'change' | 'submit' | 'keypress' | 'scroll';
      target: ReturnType<typeof describeTarget>;
      value?: string;
      key?: string;
      modifiers?: Array<'ctrl' | 'shift' | 'alt' | 'meta'>;
      scroll?: { deltaY: number; deltaX: number };
    }): void {
      // Crucial: flush any pending DOM mutations BEFORE the interaction
      // emits, so the timeline shows the previous interaction's reactions
      // immediately preceding this one. Task 6 supplies the body; until
      // then this is a no-op.
      flushMutations();
      emit({
        kind: 'interaction',
        action: args.action,
        target: args.target,
        value: args.value,
        key: args.key,
        modifiers: args.modifiers,
        scroll: args.scroll,
      });
    }

    /** Truncate a string to `max` chars, appending an ellipsis if cut. */
    function truncateValue(s: string, max: number): string {
      return s.length > max ? s.slice(0, max) + '\u2026' : s;
    }

    /** Whether an input's value should be omitted entirely (sensitive). */
    function isSensitiveInput(el: HTMLInputElement | HTMLTextAreaElement): boolean {
      if (el instanceof HTMLInputElement) {
        if (el.type === 'password') return true;
        const ac = (el.getAttribute('autocomplete') ?? '').toLowerCase();
        if (ac.startsWith('cc-')) return true;
        if (ac === 'one-time-code') return true;
      }
      return false;
    }

    // ─── Click ─────────────────────────────────────────────────────────

    function onClick(e: Event): void {
      if (stopped || !initState) return;
      const raw = e.target;
      if (!(raw instanceof Element)) return;
      const actionable = raw.closest(ACTIONABLE_SELECTOR);
      const target = actionable ?? raw;
      const me = e as MouseEvent;
      emitInteraction({
        action: 'click',
        target: describeTarget(target),
        modifiers: modifiersFromEvent(me),
      });
    }

    // ─── Input (debounced per-element) ─────────────────────────────────

    function onInput(e: Event): void {
      if (stopped || !initState) return;
      const raw = e.target;
      if (!(raw instanceof Element)) return;

      // Hidden inputs: skip entirely. They're typically state-tracking
      // form fields the user never sees \u2014 noisy and sometimes sensitive.
      if (raw instanceof HTMLInputElement && raw.type === 'hidden') return;

      const isField = raw instanceof HTMLInputElement || raw instanceof HTMLTextAreaElement;
      const isContentEditable =
        raw instanceof HTMLElement && raw.isContentEditable;
      if (!isField && !isContentEditable) return;

      // Cancel any pending flush for this element; coalesce by replacing
      // both the timer AND the latest-flusher entry so stop() drain only
      // runs ONE flush per field, not one per keystroke.
      const prev = inputDebounceTimers.get(raw);
      if (prev) clearTimeout(prev);

      const flush = () => {
        inputDebounceTimers.delete(raw);
        // Only deregister if WE are still the latest flusher for this
        // element. A subsequent onInput may have replaced us already.
        if (pendingInputFlushes.get(raw) === flush) {
          pendingInputFlushes.delete(raw);
        }
        if (!initState) return;
        if (stopped && !draining) return;
        // Re-read at flush time \u2014 the user may have typed more in the
        // debounce window, and we want the latest value, not the stale
        // event-time one.
        let value: string | undefined;
        if (isField) {
          if (isSensitiveInput(raw as HTMLInputElement | HTMLTextAreaElement)) {
            value = undefined;
          } else {
            value = truncateValue((raw as HTMLInputElement | HTMLTextAreaElement).value, INPUT_VALUE_MAX);
          }
        } else {
          // contenteditable
          value = truncateValue((raw as HTMLElement).innerText ?? '', INPUT_VALUE_MAX);
        }
        // Suppress no-op duplicates.
        const last = inputLastValue.get(raw);
        if (value !== undefined && value === last) return;
        if (value !== undefined) inputLastValue.set(raw, value);
        emitInteraction({
          action: 'input',
          target: describeTarget(raw),
          value,
        });
      };
      pendingInputFlushes.set(raw, flush);
      inputDebounceTimers.set(raw, setTimeout(flush, INPUT_DEBOUNCE_MS));
    }

    // ─── Change (selects, checkboxes, radios) ──────────────────────────

    function onChange(e: Event): void {
      if (stopped || !initState) return;
      const raw = e.target;
      if (!(raw instanceof Element)) return;

      if (raw instanceof HTMLSelectElement) {
        const opt = raw.selectedOptions[0];
        const value = opt?.value;
        const label = opt?.label || opt?.textContent?.trim() || undefined;
        emitInteraction({
          action: 'change',
          target: describeTarget(raw),
          value: label ? `${value} (${label})` : value,
        });
        return;
      }

      if (raw instanceof HTMLInputElement && (raw.type === 'checkbox' || raw.type === 'radio')) {
        emitInteraction({
          action: 'change',
          target: describeTarget(raw),
          value: raw.checked ? 'checked' : 'unchecked',
        });
        return;
      }
      // Other change events (text inputs blur, file inputs, etc.) are
      // already covered by `input` or are too noisy to record by default.
    }

    // ─── Submit ────────────────────────────────────────────────────────

    function onSubmit(e: Event): void {
      if (stopped || !initState) return;
      const raw = e.target;
      if (!(raw instanceof HTMLFormElement)) return;
      emitInteraction({
        action: 'submit',
        target: describeTarget(raw),
      });
    }

    // ─── Keydown (whitelist + modifier shortcuts) ──────────────────────

    function onKeyDown(e: Event): void {
      if (stopped || !initState) return;
      const ke = e as KeyboardEvent;
      // Skip auto-repeat: holding a key doesn't add information, and
      // can flood the recording.
      if (ke.repeat) return;
      // Skip the modifier keys themselves.
      if (MODIFIER_KEY_NAMES.has(ke.key)) return;

      const hasModifier = ke.ctrlKey || ke.altKey || ke.metaKey;
      // Plain Shift+letter is normal typing; require ctrl/alt/meta to
      // count as a "shortcut". Pure shift+key is only recorded if the
      // key is in the whitelist.
      const isWhitelisted = RECORDED_KEYS.has(ke.key);
      if (!hasModifier && !isWhitelisted) return;

      const raw = ke.target;
      if (!(raw instanceof Element)) return;
      emitInteraction({
        action: 'keypress',
        target: describeTarget(raw),
        key: ke.key,
        modifiers: modifiersFromEvent(ke),
      });
    }

    // ─── Scroll (window-only, throttled, aggregated) ───────────────────

    function onScroll(_e: Event): void {
      if (stopped || !initState) return;
      // Only window-level scrolls; arbitrary inner-scroller events are
      // too noisy and rarely meaningful to the agent.
      // Note: `target` for window scroll is `document` (not window) and
      // `scroll` doesn't bubble, but capture-phase sees it on window.
      // We accept any scroll that came through the window-capture path.
      const dx = window.scrollX - lastScrollX;
      const dy = window.scrollY - lastScrollY;
      lastScrollX = window.scrollX;
      lastScrollY = window.scrollY;
      scrollAccumDx += dx;
      scrollAccumDy += dy;

      if (scrollFlushTimer) return;
      scrollFlushTimer = setTimeout(() => {
        scrollFlushTimer = null;
        flushScroll();
      }, SCROLL_THROTTLE_MS);
    }

    function flushScroll(): void {
      if (scrollAccumDx === 0 && scrollAccumDy === 0) return;
      const dx = scrollAccumDx;
      const dy = scrollAccumDy;
      scrollAccumDx = 0;
      scrollAccumDy = 0;
      // The "target" for a window scroll is the document body; selectors
      // for window itself don't make sense.
      emitInteraction({
        action: 'scroll',
        target: describeTarget(document.body),
        scroll: { deltaX: dx, deltaY: dy },
      });
    }

    // ─── Mutation observer (Task 6 fills the body) ─────────────────────

    /** Pre-built index of "interesting" elements present at the moment of
     *  attach (or re-snapshot). Lookup happens by element identity at
     *  removal time, so we use a `WeakMap` to avoid pinning detached nodes
     *  in memory — on SPA-heavy pages (Notion / GitHub / 飞书) the churn
     *  of `<section>` / `<dialog>` / `[aria-label]` modules would otherwise
     *  accumulate for the entire recording session.
     *
     *  WeakMap is unenumerable, so the plan's step-9 "sweep" is intentionally
     *  omitted: GC reclaims entries automatically once the key element is
     *  unreachable from the rest of the page.
     *
     *  Task 6 owns the read side; Task 4 only populates and clears.
     *  WeakMap is unenumerable, which is fine for the planned lookup
     *  pattern (background hands us a removed Element, we read its meta). */
    const indexedNodes = new WeakMap<Element, ReturnType<typeof describeNode>>();

    function installMutationObserver(): void {
      // Pre-index P1 candidates: a single querySelectorAll over the
      // semantic tags + roles. We deliberately do NOT include
      // `[aria-label]` / `[aria-modal="true"]` here: the typical app page
      // has hundreds of icon-button-style aria-label elements that would
      // be queried, walked, and immediately filtered out by the area
      // threshold. Aria-label / modal nodes still get picked up at flush
      // time via the area gate on observed mutations (Task 6). The plan's
      // "union selector" was over-broad for the pre-index; restricting it
      // here keeps initial setup cheap on pages with dense ARIA markup.
      const selector = buildIndexSelector();
      try {
        const initial = document.querySelectorAll(selector);
        const viewportArea = getViewportArea();
        for (const el of initial) {
          if (meetsAreaThreshold(el, viewportArea, MUTATION_AREA_RATIO) || isSemanticContainer(el)) {
            indexedNodes.set(el, describeNode(el));
          }
        }
      } catch (err) {
        console.warn('[cebian-recorder] initial index failed:', err);
      }

      // The MutationObserver only PUSHES into a buffer; the actual
      // expensive analysis (ancestor-prefer, area thresholds, identity
      // dedup, describeNode) happens in flushMutations(). This way a page
      // doing a heavy DOM rewrite doesn't block on us inside the observer
      // callback, and we can coalesce many records into one emitted event.
      const observer = new MutationObserver((records) => {
        if (stopped) return;
        if (mutationTooMany) return;
        for (const r of records) {
          mutationBuffer.push(r);
          if (mutationBuffer.length > MUTATION_RAW_BUFFER_MAX) {
            mutationTooMany = true;
            break;
          }
        }
        scheduleMutationFlush();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      // Single cleanup with explicit ordering: drain pending records FIRST
      // (so the recording's last DOM changes land), then disconnect.
      // Splitting these into two onCleanup calls relies on LIFO drain
      // order, which is fragile; this form makes the dependency obvious.
      onCleanup(() => {
        if (mutationIdleTimer) clearTimeout(mutationIdleTimer);
        if (mutationForceTimer) clearTimeout(mutationForceTimer);
        mutationIdleTimer = null;
        mutationForceTimer = null;
        flushMutations();
        observer.disconnect();
      });
    }

    /** Union selector for nodes worth pre-indexing: semantic tags + semantic
     *  ARIA roles only. (See `installMutationObserver` for why aria-label /
     *  modal are excluded.) */
    function buildIndexSelector(): string {
      const parts: string[] = [];
      for (const tag of SEMANTIC_TAGS) parts.push(tag);
      for (const role of SEMANTIC_ROLES) parts.push(`[role="${role}"]`);
      return parts.join(',');
    }

    // ─── Mutation buffer + flush ───────────────────────────────────────

    /** Raw observed records, batched until the next flush window fires.
     *  Bounded by MUTATION_RAW_BUFFER_MAX — once the cap is hit we set
     *  `mutationTooMany` and emit a single sentinel `mutation` event so
     *  the agent can see *something* happened but the details were too
     *  expensive to record. */
    const mutationBuffer: MutationRecord[] = [];
    let mutationTooMany = false;
    let mutationIdleTimer: ReturnType<typeof setTimeout> | null = null;
    let mutationForceTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleMutationFlush(): void {
      // Idle timer: reset on every push. Captures the "page settled"
      // moment after a burst of related mutations.
      if (mutationIdleTimer) clearTimeout(mutationIdleTimer);
      mutationIdleTimer = setTimeout(() => {
        mutationIdleTimer = null;
        flushMutations();
      }, MUTATION_FLUSH_IDLE_MS);
      // Force timer: armed on the first push since the last flush, NOT
      // reset on subsequent pushes. Guarantees forward progress even on
      // a page that mutates continuously (animations, live feeds).
      if (!mutationForceTimer) {
        mutationForceTimer = setTimeout(() => {
          mutationForceTimer = null;
          flushMutations();
        }, MUTATION_FLUSH_FORCE_MS);
      }
    }

    function clearMutationTimers(): void {
      if (mutationIdleTimer) {
        clearTimeout(mutationIdleTimer);
        mutationIdleTimer = null;
      }
      if (mutationForceTimer) {
        clearTimeout(mutationForceTimer);
        mutationForceTimer = null;
      }
    }

    function flushMutations(): void {
      if (!initState) return;
      if (stopped && !draining) return;
      // tooMany handling: emit a single sentinel event so the agent knows
      // a window of mutation activity was dropped, then reset and bail.
      if (mutationTooMany) {
        mutationBuffer.length = 0;
        mutationTooMany = false;
        clearMutationTimers();
        emit({
          kind: 'mutation',
          changes: [],
          note: 'too_many_changes',
        });
        return;
      }
      if (mutationBuffer.length === 0) {
        clearMutationTimers();
        return;
      }

      // Drain the buffer first so re-entry (e.g. an emit triggers another
      // observer callback inside the same microtask) starts fresh.
      const records = mutationBuffer.slice();
      mutationBuffer.length = 0;
      clearMutationTimers();

      // ── 1. Collect candidates ────────────────────────────────────────
      const viewportArea = getViewportArea();
      const addedSet = new Set<Element>();
      const removedSet = new Set<Element>();
      // Cache rects from the area-threshold check so describeNode doesn't
      // re-read getBoundingClientRect for the same element later.
      const addedRects = new Map<Element, DOMRect>();

      for (const r of records) {
        // We observe { childList: true, subtree: true } only, so the
        // node lists are the only fields we need from each record.
        for (const n of r.addedNodes) {
          if (!(n instanceof Element)) continue;
          // Skip nodes that have already been detached again by the time
          // we flush — a common SPA pattern is "add child, remove ancestor"
          // in the same window. The browser only reports the ancestor in
          // removedNodes, so the descendant survives short-lived cancel
          // and would otherwise produce an "appeared" event with a
          // useless detached selector and zero rect.
          if (!n.isConnected) continue;
          if (isSemanticContainer(n)) {
            addedSet.add(n);
            continue;
          }
          const rect = n.getBoundingClientRect();
          if (rectMeetsAreaThreshold(rect, viewportArea, MUTATION_AREA_RATIO)) {
            addedSet.add(n);
            addedRects.set(n, rect);
          }
        }
        for (const n of r.removedNodes) {
          if (!(n instanceof Element)) continue;
          // No filter on removed: if a node was previously interesting
          // enough to be in indexedNodes, we want to record its loss
          // even if its current rect is 0×0 (it's detached now). The
          // self-check below handles the unindexed case.
          removedSet.add(n);
        }
      }

      // ── 2. Short-lived cancel ────────────────────────────────────────
      // If a node appears in both added and removed (DOM identity match),
      // it appeared and disappeared within this flush window — drop both.
      // Catches the "open then immediately close" modal pattern.
      const canceled: Element[] = [];
      for (const n of addedSet) {
        if (removedSet.has(n)) canceled.push(n);
      }
      for (const n of canceled) {
        addedSet.delete(n);
        removedSet.delete(n);
      }

      // ── 3. Ancestor-prefer on added ─────────────────────────────────
      // Drop any candidate whose ancestor (within the same set) is also
      // a candidate. Keeps the timeline focused on the outermost module
      // boundary the user can actually perceive.
      const addedKept: Element[] = [];
      for (const n of addedSet) {
        let dominated = false;
        for (const other of addedSet) {
          if (other === n) continue;
          // contains() returns true for self; we already excluded that.
          if (other.contains(n)) { dominated = true; break; }
        }
        if (!dominated) addedKept.push(n);
      }

      // ── 4. Build changes ────────────────────────────────────────────
      const changes: MutationChange[] = [];

      for (const el of addedKept) {
        const meta = describeNode(el, addedRects.get(el));
        // Update the index so a later disappearance can recover metadata
        // even if the node is detached by then.
        indexedNodes.set(el, meta);
        changes.push({ op: 'appeared', ...meta });
      }

      for (const el of removedSet) {
        const stored = indexedNodes.get(el);
        if (stored) {
          changes.push({ op: 'disappeared', ...stored });
          continue;
        }
        // P2 fallback: node wasn't pre-indexed. Self-check whether it's
        // still recognizable as a semantic container — its tagName /
        // attributes survive detachment, so isSemanticContainer is safe.
        if (isSemanticContainer(el)) {
          changes.push({
            op: 'disappeared',
            tag: el.tagName.toLowerCase(),
            role: getRole(el),
            label: getLabel(el),
          });
        }
        // Else: drop. Was probably noise (e.g. an inline span removed
        // by a re-render).
      }

      if (changes.length === 0) return;

      emit({
        kind: 'mutation',
        changes,
      });
    }
  },
});

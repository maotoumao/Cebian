import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_INTERACT } from '@/lib/tools/names';
import { executeInTabWithArgs, waitForNavigation } from '@/lib/tab-helpers';

// ─── Shared field schemas (reused by top-level params and sequence steps) ───

const selectorField = Type.Optional(Type.String({
  description:
    'CSS selector of the target element. ' +
    'Required for: type, clear, select, focus, wait, wait_hidden. ' +
    'Optional for: click, dblclick, rightclick, hover (alternative: x + y). ' +
    'Optional for: scroll (provide to scroll within a specific container, omit to scroll the page). ' +
    'Optional for: keypress (when provided, the element is focused before the key is dispatched — use this to guarantee keystrokes reach the intended element, e.g. pressing Enter in a search box).',
}));
const xField = Type.Optional(Type.Number({
  description:
    'X coordinate in CSS viewport pixels (0 = left edge of the visible area). ' +
    'For click/dblclick/rightclick/hover as an alternative to selector. ' +
    'NOT screenshot pixels: if you are reading a coordinate off a `screenshot` result, divide by the reported `dpr` first. ' +
    'A selector from `inspect` is strongly preferred over raw coordinates — coordinates are fragile (scroll / layout shifts invalidate them).',
}));
const yField = Type.Optional(Type.Number({
  description:
    'Y coordinate in CSS viewport pixels (0 = top edge of the visible area). ' +
    'Same rules as `x` — CSS pixels, not screenshot pixels.',
}));
const textField = Type.Optional(Type.String({
  description: 'Text content. Required for: type (text to input), select (option text/value to pick).',
}));
const keyField = Type.Optional(Type.String({
  description: 'Key name for keypress (e.g. "Enter", "Tab", "Escape", "ArrowDown"). Required for keypress.',
}));
const modifiersField = Type.Optional(Type.Array(Type.String(), {
  description: 'Modifier keys to hold: "ctrl", "shift", "alt", "meta".',
}));
const deltaXField = Type.Optional(Type.Number({
  description: 'Horizontal scroll amount for scroll. Default: 0.',
}));
const deltaYField = Type.Optional(Type.Number({
  description: 'Vertical scroll amount for scroll. Positive = down. Default: 300.',
}));
const timeoutField = Type.Optional(Type.Number({
  description: 'Timeout in ms for wait/wait_hidden. Default: 3000.',
}));

/** Actions available inside sequence steps. */
const stepActions = [
  Type.Literal('click'), Type.Literal('dblclick'), Type.Literal('rightclick'),
  Type.Literal('hover'), Type.Literal('focus'), Type.Literal('type'), Type.Literal('clear'),
  Type.Literal('select'), Type.Literal('scroll'), Type.Literal('keypress'),
  Type.Literal('wait'), Type.Literal('wait_hidden'),
] as const;

// ─── Parameters: single flat object (OpenAI requires top-level "type": "object") ───

const InteractParameters = Type.Object({
  action: Type.Union([
    ...stepActions, Type.Literal('wait_navigation'),
    Type.Literal('sequence'),
  ], { description: 'The interaction to perform. For element discovery, use the dedicated `inspect` tool.' }),
  selector: selectorField,
  x: xField,
  y: yField,
  text: Type.Optional(Type.String({
    description:
      'Text content. ' +
      'Required for: type (text to input), select (option text/value to pick).',
  })),
  key: keyField,
  modifiers: modifiersField,
  deltaX: deltaXField,
  deltaY: deltaYField,
  timeout: Type.Optional(Type.Number({
    description: 'Timeout in ms for wait, wait_hidden, wait_navigation. Default: 3000.',
  })),
  frameId: Type.Optional(Type.Number({
    description: 'Frame ID to interact with. Omit for top frame. Use tab({ action: "list_frames" }) to discover IDs.',
  })),
  tabId: Type.Number({
    description: 'Required for EVERY action (including wait, wait_hidden, wait_navigation) — all actions run by injecting into a specific tab. Read it from the `tabId:` line under `[Active Tab]` (or the windows list) in the context block. If no tab ID is available in context, call `tab({ action: "list" })` first to discover one. Never omit, never guess, and never pass 0 or a placeholder value.',
  }),
  steps: Type.Optional(Type.Array(
    Type.Object({
      action: Type.Union([...stepActions], { description: 'Step action. `wait_navigation` not allowed here — call it separately after the sequence.' }),
      selector: selectorField,
      x: xField,
      y: yField,
      text: textField,
      key: keyField,
      modifiers: modifiersField,
      deltaX: deltaXField,
      deltaY: deltaYField,
      timeout: timeoutField,
    }),
    {
      description:
        'Array of interaction steps for "sequence" action. ' +
        'Each step uses the same parameters as the top-level interact tool (selector, x/y, text, key, etc.). ' +
        'Steps are executed in order. Execution stops on the first error.',
    },
  )),
});

// ─── In-page interaction function (self-contained) ───

function performInteraction(params: {
  action: string;
  selector?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  modifiers?: string[];
  deltaX?: number;
  deltaY?: number;
  timeout?: number;
}): Promise<string> {
  const { action, selector, x, y, text, key, modifiers, deltaX, deltaY, timeout = 3000 } = params;

  /** Whether the element was found by coordinates (skip scrollIntoView). */
  let resolvedByCoords = false;

  function getEl(): HTMLElement {
    if (selector) {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) throw new Error(`Element not found: ${selector}`);
      return el;
    }
    if (x != null && y != null) {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!el) throw new Error(`No element at coordinates (${x}, ${y})`);
      resolvedByCoords = true;
      return el;
    }
    throw new Error('Either selector or x/y coordinates are required.');
  }

  /** Description of what was targeted, for result messages. */
  const targetDesc = selector ?? `(${x}, ${y})`;

  function modInit() {
    return {
      ctrlKey: modifiers?.includes('ctrl') ?? false,
      shiftKey: modifiers?.includes('shift') ?? false,
      altKey: modifiers?.includes('alt') ?? false,
      metaKey: modifiers?.includes('meta') ?? false,
    };
  }

  /**
   * Map `KeyboardEvent.key` → legacy `keyCode` / `which` numeric value.
   *
   * `new KeyboardEvent(type, { key })` does NOT auto-derive `keyCode` — it
   * stays `0` unless explicitly set. Lots of real-world pages (百度搜索框、
   * 老 jQuery 插件、Baidu/Alipay 内嵌组件) still gate behavior on
   * `e.keyCode === 13` / `=== 8`, so a synthetic event with `keyCode: 0`
   * is silently ignored. We populate it best-effort.
   *
   * Naming key table covers the keys an automation agent realistically
   * sends. For single-character keys we approximate: letters → uppercase
   * char code (matches the physical-key semantics of keyCode regardless of
   * the typed case), digits → char code. Shifted symbols (`!`, `@`, …)
   * fall through to char code — not the unshifted physical-key code per
   * spec, but agents almost never `keypress` a single shifted symbol.
   */
  function keyCodeFor(k: string): number {
    const named: Record<string, number> = {
      Backspace: 8, Tab: 9, Enter: 13,
      Shift: 16, Control: 17, Alt: 18,
      Pause: 19, CapsLock: 20, Escape: 27, Space: 32,
      PageUp: 33, PageDown: 34, End: 35, Home: 36,
      ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
      Insert: 45, Delete: 46,
      Meta: 91, ContextMenu: 93,
      F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
      F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
      NumLock: 144, ScrollLock: 145,
      ';': 186, '=': 187, ',': 188, '-': 189, '.': 190, '/': 191, '`': 192,
      '[': 219, '\\': 220, ']': 221, "'": 222,
    };
    if (k in named) return named[k];
    // Spec spelling for spacebar is the literal " "; the friendly alias
    // "Space" is also accepted because agents commonly invent that name.
    if (k === ' ') return 32;
    if (k.length === 1) {
      const c = k.charCodeAt(0);
      // Letters: keyCode is the uppercase code regardless of typed case.
      if (c >= 0x61 && c <= 0x7A) return c - 32; // a-z → A-Z
      return c;
    }
    return 0;
  }

  /**
   * Map `KeyboardEvent.key` → DOM `KeyboardEvent.code` (physical key id,
   * layout-independent). Modern shortcut libs (tinykeys, CodeMirror 6) read
   * `code` rather than `key`. Best-effort: letters → `Key{X}`, digits →
   * `Digit{n}`, named keys → table lookup, otherwise empty string.
   */
  function domCodeFor(k: string): string {
    const named: Record<string, string> = {
      Backspace: 'Backspace', Tab: 'Tab', Enter: 'Enter',
      Shift: 'ShiftLeft', Control: 'ControlLeft', Alt: 'AltLeft',
      Pause: 'Pause', CapsLock: 'CapsLock', Escape: 'Escape',
      PageUp: 'PageUp', PageDown: 'PageDown', End: 'End', Home: 'Home',
      ArrowLeft: 'ArrowLeft', ArrowUp: 'ArrowUp',
      ArrowRight: 'ArrowRight', ArrowDown: 'ArrowDown',
      Insert: 'Insert', Delete: 'Delete',
      Meta: 'MetaLeft', ContextMenu: 'ContextMenu',
      F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
      F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
      NumLock: 'NumLock', ScrollLock: 'ScrollLock',
      ';': 'Semicolon', '=': 'Equal', ',': 'Comma', '-': 'Minus',
      '.': 'Period', '/': 'Slash', '`': 'Backquote',
      '[': 'BracketLeft', '\\': 'Backslash', ']': 'BracketRight',
      "'": 'Quote',
    };
    if (k in named) return named[k];
    if (k === ' ') return 'Space';
    if (k.length === 1) {
      const c = k.charCodeAt(0);
      if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)) {
        return 'Key' + k.toUpperCase();
      }
      if (c >= 0x30 && c <= 0x39) return 'Digit' + k;
    }
    return '';
  }

  /**
   * Resolve the target element + concrete click point for pointer-based actions
   * (click / dblclick / rightclick / hover). Unlike `getEl()` this always
   * produces a `{ clientX, clientY }` pair so downstream `MouseEvent` /
   * `PointerEvent` dispatches carry real coordinates — many pages read
   * `event.clientX/Y` (canvas, maps, editors, Radix/shadcn popovers) and
   * silently mis-handle events with the default 0,0.
   *
   * Selector path: scroll into view, point = center of bounding rect.
   * Coordinate path: auto-correct DPR mistakes (agents reading screenshots
   * often pass screenshot-pixel coords), then pick the topmost element whose
   * `pointer-events !== none` via `elementsFromPoint` — `elementFromPoint`
   * alone can return a transparent overlay that swallows the event.
   */
  function resolveTarget(): { el: HTMLElement; point: { clientX: number; clientY: number } } {
    if (selector) {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) throw new Error(`Element not found: ${selector}`);
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { el, point: { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 } };
    }
    if (x != null && y != null) {
      let cx = x;
      let cy = y;
      // DPR auto-correction: if (x, y) falls outside the viewport but (x/dpr, y/dpr)
      // lands inside it, the agent almost certainly passed screenshot pixels. Rescue
      // the call instead of failing. Harmless for callers already using CSS pixels
      // because in-viewport coordinates short-circuit the `if`.
      const dpr = window.devicePixelRatio || 1;
      if (dpr > 1
        && (cx > window.innerWidth || cy > window.innerHeight)
        && cx / dpr <= window.innerWidth
        && cy / dpr <= window.innerHeight) {
        cx = cx / dpr;
        cy = cy / dpr;
      }
      const stack = document.elementsFromPoint(cx, cy) as HTMLElement[];
      if (stack.length === 0) throw new Error(`No element at coordinates (${x}, ${y})`);
      const el = stack.find(e => getComputedStyle(e).pointerEvents !== 'none') ?? stack[0];
      return { el, point: { clientX: cx, clientY: cy } };
    }
    throw new Error('Either selector or x/y coordinates are required.');
  }

  /**
   * Dispatch a realistic pointer + mouse event sequence at a specific point.
   * Modern frameworks (React synthetic events, Radix, Floating UI, CodeMirror,
   * Monaco, map libs, canvas games) split their handlers across PointerEvents
   * and MouseEvents and read `clientX/Y` for hit-testing — sending only a bare
   * `el.click()` at (0,0) misses most of them.
   */
  function dispatchPointerSequence(
    el: HTMLElement,
    point: { clientX: number; clientY: number },
    kind: 'click' | 'dblclick' | 'rightclick' | 'hover',
  ): void {
    const button = kind === 'rightclick' ? 2 : 0;
    // `buttons` is the set of buttons currently held. During press-phase events
    // (pointerdown, mousedown) it is the button's bitmask; during release-phase
    // events (pointerup, mouseup, click, contextmenu) it must go back to 0.
    // Drag-detection libraries (dnd-kit, react-dnd, some canvas apps) gate on
    // this — a non-zero `buttons` on the up-phase confuses them.
    const pressedBit = kind === 'rightclick' ? 2 : (kind === 'hover' ? 0 : 1);
    const baseInit = {
      bubbles: true, composed: true, cancelable: true,
      view: window, button,
      clientX: point.clientX, clientY: point.clientY,
      ...modInit(),
    };
    const mDown: MouseEventInit = { ...baseInit, buttons: pressedBit };
    const mUp: MouseEventInit = { ...baseInit, buttons: 0 };
    const pExtras = {
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
      width: 1, height: 1,
    };
    const pDown: PointerEventInit = { ...mDown, ...pExtras, pressure: kind === 'hover' ? 0 : 0.5 };
    const pUp: PointerEventInit = { ...mUp, ...pExtras, pressure: 0 };

    if (kind === 'hover') {
      el.dispatchEvent(new PointerEvent('pointerover', pUp));
      el.dispatchEvent(new MouseEvent('mouseover', mUp));
      el.dispatchEvent(new PointerEvent('pointerenter', { ...pUp, bubbles: false }));
      el.dispatchEvent(new MouseEvent('mouseenter', { ...mUp, bubbles: false }));
      el.dispatchEvent(new PointerEvent('pointermove', pUp));
      el.dispatchEvent(new MouseEvent('mousemove', mUp));
      return;
    }

    el.dispatchEvent(new PointerEvent('pointerdown', pDown));
    el.dispatchEvent(new MouseEvent('mousedown', mDown));
    el.dispatchEvent(new PointerEvent('pointerup', pUp));
    el.dispatchEvent(new MouseEvent('mouseup', mUp));

    if (kind === 'rightclick') {
      // Spec note: `contextmenu` ordering varies across platforms (Windows fires
      // between mousedown and mouseup, Linux/macOS fire after mouseup). We use
      // the Linux/macOS order, which matches what most modern libs expect.
      el.dispatchEvent(new MouseEvent('contextmenu', mUp));
      return;
    }

    el.dispatchEvent(new MouseEvent('click', { ...mUp, detail: 1 }));
    if (kind === 'dblclick') {
      // Second click + dblclick, per the DOM spec sequence.
      el.dispatchEvent(new PointerEvent('pointerdown', pDown));
      el.dispatchEvent(new MouseEvent('mousedown', mDown));
      el.dispatchEvent(new PointerEvent('pointerup', pUp));
      el.dispatchEvent(new MouseEvent('mouseup', mUp));
      el.dispatchEvent(new MouseEvent('click', { ...mUp, detail: 2 }));
      el.dispatchEvent(new MouseEvent('dblclick', { ...mUp, detail: 2 }));
    }
  }

  switch (action) {
    case 'click': {
      const { el, point } = resolveTarget();
      dispatchPointerSequence(el, point, 'click');
      return Promise.resolve(`Clicked: ${targetDesc}`);
    }

    case 'dblclick': {
      const { el, point } = resolveTarget();
      dispatchPointerSequence(el, point, 'dblclick');
      return Promise.resolve(`Double-clicked: ${targetDesc}`);
    }

    case 'rightclick': {
      const { el, point } = resolveTarget();
      dispatchPointerSequence(el, point, 'rightclick');
      return Promise.resolve(`Right-clicked: ${targetDesc}`);
    }

    case 'hover': {
      const { el, point } = resolveTarget();
      dispatchPointerSequence(el, point, 'hover');
      return Promise.resolve(`Hovered: ${targetDesc}`);
    }

    case 'type': {
      const el = getEl();
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.focus();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, (el.value ?? '') + (text ?? ''));
        } else {
          el.value = (el.value ?? '') + (text ?? '');
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        document.execCommand('insertText', false, text ?? '');
      }
      return Promise.resolve(`Typed "${text}" into: ${selector}`);
    }

    case 'clear': {
      const el = getEl();
      el.focus();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, '');
        } else {
          el.value = '';
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.focus();
        document.execCommand('selectAll', false);
        document.execCommand('delete', false);
      }
      return Promise.resolve(`Cleared: ${selector}`);
    }

    case 'select': {
      const el = getEl();
      if (el instanceof HTMLSelectElement) {
        const option = Array.from(el.options).find(o => o.text === text || o.value === text);
        if (!option) throw new Error(`Option not found: ${text}`);
        el.value = option.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return Promise.resolve(`Selected "${text}" in: ${selector}`);
      }
      throw new Error(`Element is not a <select>: ${selector}`);
    }

    case 'scroll': {
      const target = selector ? getEl() : document.documentElement;
      target.scrollBy({ left: deltaX ?? 0, top: deltaY ?? 300, behavior: 'smooth' });
      return Promise.resolve(
        selector
          ? `Scrolled ${selector} by (${deltaX ?? 0}, ${deltaY ?? 300})`
          : `Scrolled page by (${deltaX ?? 0}, ${deltaY ?? 300})`,
      );
    }

    case 'focus': {
      const el = getEl();
      if (!resolvedByCoords) el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.focus();
      if (document.activeElement !== el) {
        return Promise.resolve(
          `Error: Element did not accept focus (not focusable): ${targetDesc}. ` +
          `Target an actual input/textarea/button/contenteditable, or an element with tabindex.`
        );
      }
      return Promise.resolve(`Focused: ${targetDesc}`);
    }

    case 'keypress': {
      if (!key) throw new Error('"key" is required for keypress action.');
      // If selector provided, focus that element first so the keystroke is guaranteed
      // to reach the intended target (activeElement may have drifted since last action).
      let target: Element;
      if (selector) {
        const el = getEl();
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();
        if (document.activeElement !== el) {
          return Promise.resolve(
            `Error: Element did not accept focus, cannot send keypress reliably: ${selector}. ` +
            `Target an actual input/textarea/button/contenteditable — a wrapper div will receive the event but won't trigger form submit.`
          );
        }
        target = el;
      } else {
        target = document.activeElement ?? document.body;
      }
      const code = keyCodeFor(key);
      const init: KeyboardEventInit = {
        key,
        code: domCodeFor(key),
        keyCode: code,
        which: code,
        bubbles: true,
        cancelable: true,
        composed: true,
        ...modInit(),
      };
      target.dispatchEvent(new KeyboardEvent('keydown', init));
      // Real browsers only fire `keypress` for character-producing keys.
      // Modifier keys (Shift/Control/Alt/Meta/CapsLock/NumLock/ScrollLock)
      // and non-printable named keys (Backspace/Tab/Escape/Arrow*/F*/Home/
      // End/PageUp/PageDown/Delete/Insert) do NOT get a keypress. Enter is
      // kept by all engines for back-compat.
      if (key.length === 1 || key === 'Enter') {
        target.dispatchEvent(new KeyboardEvent('keypress', init));
      }
      target.dispatchEvent(new KeyboardEvent('keyup', init));
      return Promise.resolve(selector ? `Pressed key ${key} on: ${selector}` : `Pressed key: ${key}`);
    }

    case 'wait': {
      if (!selector) throw new Error('"selector" is required for wait action.');
      return new Promise<string>((resolve, reject) => {
        const existing = document.querySelector(selector);
        if (existing) { resolve(`Element found: ${selector}`); return; }
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`Timeout: element ${selector} not found within ${timeout}ms`));
        }, timeout);
        const observer = new MutationObserver(() => {
          if (document.querySelector(selector)) {
            observer.disconnect();
            clearTimeout(timer);
            resolve(`Element appeared: ${selector}`);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }

    case 'wait_hidden': {
      if (!selector) throw new Error('"selector" is required for wait_hidden action.');
      const isHidden = (sel: string) => {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) return true;
        const style = getComputedStyle(el);
        return style.display === 'none' || style.visibility === 'hidden';
      };
      return new Promise<string>((resolve, reject) => {
        if (isHidden(selector)) { resolve(`Element already hidden: ${selector}`); return; }
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`Timeout: element ${selector} still visible after ${timeout}ms`));
        }, timeout);
        const observer = new MutationObserver(() => {
          if (isHidden(selector)) {
            observer.disconnect();
            clearTimeout(timer);
            resolve(`Element disappeared: ${selector}`);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      });
    }

    default:
      // Resolve (don't reject) — chrome.scripting.executeScript silently swallows
      // rejections from injected functions, which would surface to the model as an
      // empty success and trigger hallucinations. Returning the error as a string
      // ensures the model sees the failure.
      return Promise.resolve(
        `Error: Unknown action "${action}".`
      );
  }
}

// ─── Tool definition ───

export const interactTool: AgentTool<typeof InteractParameters> = {
  name: TOOL_INTERACT,
  label: 'Interact',
  description:
    'Simulate user interactions on a browser tab (defaults to the active tab). ' +
    'Actions: click, dblclick, rightclick, hover (target by CSS selector or x/y coordinates), ' +
    'focus (give an element keyboard focus without clicking — useful before keypress, or to reveal focus-only UI like autocompletes), ' +
    'type (text input), clear, select (dropdown), scroll (page or element via selector), ' +
    'keypress (pass a selector to focus that element first — strongly recommended when submitting forms via Enter), ' +
    'wait (element appears), wait_hidden (element disappears), ' +
    'wait_navigation (page load completes). ' +
    'For element discovery, use the dedicated `inspect` tool — it returns absolute selectors, role, label, and state. ' +
    'Use "sequence" with a "steps" array to batch multiple actions in one call ' +
    '(e.g. click → wait → type → keypress). Each step supports the same parameters. ' +
    'Execution stops on the first error and returns all results so far. ' +
    'Elements are scrolled into view automatically before interaction.',
  parameters: InteractParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{}>> {
    signal?.throwIfAborted();
    const tabId = params.tabId;

    // wait_navigation runs in extension context (not in-page)
    if (params.action === 'wait_navigation') {
      const result = await waitForNavigation(tabId, params.timeout ?? 3000);
      return {
        content: [{ type: 'text', text: result }],
        details: {},
      };
    }

    // sequence: run multiple steps in order, in-page
    if (params.action === 'sequence') {
      // Some models (notably DeepSeek) serialize nested array params as a JSON
      // string instead of a real array. Without this rescue we'd iterate the
      // string char-by-char, injecting hundreds of bogus actions before the
      // model sees any feedback. Try to parse, otherwise fail loudly with a
      // message that names the real problem.
      let steps = params.steps as unknown;
      if (typeof steps === 'string') {
        try {
          steps = JSON.parse(steps);
        } catch {
          throw new Error('"steps" was passed as a string but is not valid JSON. Pass it as a JSON array of step objects, e.g. [{"action":"click","selector":"#btn"}].');
        }
      }
      if (!Array.isArray(steps)) {
        throw new Error(`"steps" must be a JSON array of step objects (received ${typeof steps}).`);
      }
      if (steps.length === 0) {
        throw new Error('"steps" array is required for sequence action.');
      }

      const frameId = params.frameId;
      const results: string[] = [];

      for (let i = 0; i < steps.length; i++) {
        signal?.throwIfAborted();
        const step = steps[i];

        try {
          const result = await runInPageStep(tabId, step, frameId);
          results.push(`[${i + 1}] ${result}`);
        } catch (err) {
          // 中途失败：把已经跑过的 step 结果连同失败原因一起抛出，让 agent 看到全貌
          results.push(`[${i + 1}] Error: ${(err as Error).message}`);
          throw new Error(`Sequence stopped at step ${i + 1}:\n${results.join('\n')}`);
        }
      }

      return {
        content: [{ type: 'text', text: `Sequence completed (${steps.length} steps):\n${results.join('\n')}` }],
        details: {},
      };
    }

    // All other actions run in-page
    const result = await runInPageStep(tabId, params, params.frameId);
    return {
      content: [{ type: 'text', text: result }],
      details: {},
    };
  },
};

/**
 * 在目标 tab 跑一次 in-page interaction，并把 chrome.scripting 的两种
 * 静默失败通道转成真正的 throw：
 *
 * 1. 注入函数 `throw new Error(...)` → chrome.scripting 吞掉 rejection，
 *    `executeInTabWithArgs` 返回 `undefined`。
 * 2. 注入函数返回 `"Error: <msg>"` sentinel 字符串（`performInteraction`
 *    在内部 catch 后采用这种方式上报，因为 reject 会被吞）。
 *
 * 两者都让上层看到真的异常，pi-agent-core 会把 `isError: true` 设到
 * 这次 tool call 的结果上。
 */
async function runInPageStep(
  tabId: number,
  step: unknown,
  frameId?: number,
): Promise<string> {
  // `performInteraction` 自身校验 step.action，并对未知 / 缺参情况返回
  // 带 "Error:" 前缀的字符串 sentinel；这里直接转交，下面统一处理。
  const result = await executeInTabWithArgs(tabId, performInteraction, [step as Parameters<typeof performInteraction>[0]], frameId);
  const action = (step as { action?: string })?.action ?? 'unknown';
  if (result === undefined) {
    throw new Error(`in-page execution of "${action}" returned no result (likely an uncaught exception in the page).`);
  }
  if (typeof result === 'string' && result.startsWith('Error:')) {
    // 去掉 in-page sentinel 前缀，isError 现在承担信号责任
    throw new Error(result.slice('Error:'.length).trim());
  }
  return result as string;
}

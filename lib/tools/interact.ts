import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_INTERACT } from '@/lib/types';
import { getActiveTabId, executeInTabWithArgs, waitForNavigation } from './chrome-api';

// ─── Parameters: single flat object (OpenAI requires top-level "type": "object") ───

const InteractParameters = Type.Object({
  action: Type.Union([
    Type.Literal('click'), Type.Literal('dblclick'), Type.Literal('rightclick'),
    Type.Literal('hover'), Type.Literal('type'), Type.Literal('clear'),
    Type.Literal('select'), Type.Literal('scroll'), Type.Literal('keypress'),
    Type.Literal('wait'), Type.Literal('wait_hidden'), Type.Literal('wait_navigation'),
    Type.Literal('find'),
  ], { description: 'The interaction to perform.' }),
  selector: Type.Optional(Type.String({
    description:
      'CSS selector of the target element. ' +
      'Required for: type, clear, select, wait, wait_hidden. ' +
      'Optional for: click, dblclick, rightclick, hover (alternative: provide x + y instead). ' +
      'Optional for: scroll (omit to scroll the page). ' +
      'Not used by: keypress, wait_navigation, find.',
  })),
  x: Type.Optional(Type.Number({
    description:
      'X viewport coordinate (pixels, must be visible on screen). ' +
      'For click/dblclick/rightclick/hover only. Provide x + y together as alternative to selector.',
  })),
  y: Type.Optional(Type.Number({
    description:
      'Y viewport coordinate (pixels, must be visible on screen). ' +
      'For click/dblclick/rightclick/hover only. Provide x + y together as alternative to selector.',
  })),
  text: Type.Optional(Type.String({
    description:
      'Text content. ' +
      'Required for: type (text to input), select (option text/value to pick), find (text to search for).',
  })),
  key: Type.Optional(Type.String({
    description: 'Key name for "keypress" action (e.g. "Enter", "Tab", "Escape", "ArrowDown"). Required for keypress.',
  })),
  modifiers: Type.Optional(Type.Array(Type.String(), {
    description: 'Modifier keys to hold during keypress: "ctrl", "shift", "alt", "meta".',
  })),
  deltaX: Type.Optional(Type.Number({
    description: 'Horizontal scroll amount for "scroll" action. Default: 0.',
  })),
  deltaY: Type.Optional(Type.Number({
    description: 'Vertical scroll amount for "scroll" action. Positive = down. Default: 300.',
  })),
  timeout: Type.Optional(Type.Number({
    description: 'Timeout in ms for wait, wait_hidden, wait_navigation. Default: 5000.',
  })),
  nth: Type.Optional(Type.Number({
    description: 'Match index (0-based) for "find" action. Default: 0 (first match).',
  })),
  frameId: Type.Optional(Type.Number({
    description: 'Frame ID to interact with. Omit for top frame. Use tab({ action: "list_frames" }) to discover IDs.',
  })),
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
  nth?: number;
}): Promise<string> {
  const { action, selector, x, y, text, key, modifiers, deltaX, deltaY, timeout = 5000, nth = 0 } = params;

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

  switch (action) {
    case 'click': {
      const el = getEl();
      if (!resolvedByCoords) el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ...modInit() }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, ...modInit() }));
      el.click();
      return Promise.resolve(`Clicked: ${targetDesc}`);
    }

    case 'dblclick': {
      const el = getEl();
      if (!resolvedByCoords) el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return Promise.resolve(`Double-clicked: ${targetDesc}`);
    }

    case 'rightclick': {
      const el = getEl();
      if (!resolvedByCoords) el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
      return Promise.resolve(`Right-clicked: ${targetDesc}`);
    }

    case 'hover': {
      const el = getEl();
      if (!resolvedByCoords) el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
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

    case 'keypress': {
      if (!key) throw new Error('"key" is required for keypress action.');
      const target = document.activeElement ?? document.body;
      const init: KeyboardEventInit = { key, bubbles: true, ...modInit() };
      target.dispatchEvent(new KeyboardEvent('keydown', init));
      target.dispatchEvent(new KeyboardEvent('keypress', init));
      target.dispatchEvent(new KeyboardEvent('keyup', init));
      return Promise.resolve(`Pressed key: ${key}`);
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

    case 'find': {
      if (!text) throw new Error('"text" is required for find action.');
      const walker = document.createTreeWalker(
        document.body, NodeFilter.SHOW_TEXT, null,
      );
      const matches: { selector: string; context: string }[] = [];
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        if (node.textContent && node.textContent.includes(text)) {
          const parent = node.parentElement;
          if (!parent) continue;
          // Build a CSS selector path
          const path: string[] = [];
          let el: HTMLElement | null = parent;
          while (el && el !== document.body) {
            let seg = el.tagName.toLowerCase();
            if (el.id) {
              seg = '#' + CSS.escape(el.id);
              path.unshift(seg);
              break;
            }
            const siblings = el.parentElement
              ? Array.from(el.parentElement.children).filter(c => c.tagName === el!.tagName)
              : [];
            if (siblings.length > 1) {
              seg += `:nth-of-type(${siblings.indexOf(el) + 1})`;
            }
            path.unshift(seg);
            el = el.parentElement;
          }
          const selectorPath = path.join(' > ');
          const fullText = parent.innerText.trim();
          const context = fullText.length > 100
            ? fullText.slice(0, 100) + '...'
            : fullText;
          matches.push({ selector: selectorPath, context });
        }
      }
      if (matches.length === 0) return Promise.resolve(`No matches found for: "${text}"`);
      if (nth >= matches.length) {
        return Promise.resolve(
          `Only ${matches.length} match(es) found for "${text}", requested index ${nth}.\n` +
          matches.map((m, i) => `[${i}] ${m.selector} — "${m.context}"`).join('\n'),
        );
      }
      const match = matches[nth];
      return Promise.resolve(
        `Found (${matches.length} total, showing #${nth}):\n` +
        `  selector: ${match.selector}\n` +
        `  context: "${match.context}"`,
      );
    }

    default:
      return Promise.reject(new Error(`Unknown action: ${action}`));
  }
}

// ─── Tool definition ───

export const interactTool: AgentTool<typeof InteractParameters> = {
  name: TOOL_INTERACT,
  label: 'Interact',
  description:
    'Simulate user interactions on the active page. ' +
    'Actions: click, dblclick, rightclick, hover (target by CSS selector or x/y coordinates), ' +
    'type (text input), clear, select (dropdown), scroll, keypress, ' +
    'wait (element appears), wait_hidden (element disappears), ' +
    'wait_navigation (page load completes), find (search text in page and return selector). ' +
    'Elements are scrolled into view automatically before interaction.',
  parameters: InteractParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    const tabId = await getActiveTabId();

    // wait_navigation runs in extension context (not in-page)
    if (params.action === 'wait_navigation') {
      try {
        const result = await waitForNavigation(tabId, params.timeout ?? 5000);
        return {
          content: [{ type: 'text', text: result }],
          details: { status: 'done' },
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          details: { status: 'error' },
        };
      }
    }

    // All other actions run in-page
    const frameId = params.frameId;
    try {
      const result = await executeInTabWithArgs(tabId, performInteraction, [params], frameId);
      return {
        content: [{ type: 'text', text: result }],
        details: { status: 'done' },
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        details: { status: 'error' },
      };
    }
  },
};

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_INTERACT } from '@/lib/types';
import { resolveTabId, executeInTabWithArgs, waitForNavigation } from './chrome-api';

// ─── Shared field schemas (reused by top-level params and sequence steps) ───

const selectorField = Type.Optional(Type.String({
  description:
    'CSS selector of the target element. ' +
    'Required for: type, clear, select, wait, wait_hidden. ' +
    'Optional for: click, dblclick, rightclick, hover (alternative: x + y). ' +
    'Optional for: scroll (provide to scroll within a specific container, omit to scroll the page).',
}));
const xField = Type.Optional(Type.Number({
  description: 'X viewport coordinate. For click/dblclick/rightclick/hover as alternative to selector.',
}));
const yField = Type.Optional(Type.Number({
  description: 'Y viewport coordinate. For click/dblclick/rightclick/hover as alternative to selector.',
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
  Type.Literal('hover'), Type.Literal('type'), Type.Literal('clear'),
  Type.Literal('select'), Type.Literal('scroll'), Type.Literal('keypress'),
  Type.Literal('wait'), Type.Literal('wait_hidden'),
] as const;

// ─── Parameters: single flat object (OpenAI requires top-level "type": "object") ───

const InteractParameters = Type.Object({
  action: Type.Union([
    ...stepActions, Type.Literal('wait_navigation'),
    Type.Literal('find'), Type.Literal('query'), Type.Literal('sequence'),
  ], { description: 'The interaction to perform.' }),
  selector: selectorField,
  x: xField,
  y: yField,
  text: Type.Optional(Type.String({
    description:
      'Text content. ' +
      'Required for: type (text to input), select (option text/value to pick), find (text to search for).',
  })),
  key: keyField,
  modifiers: modifiersField,
  deltaX: deltaXField,
  deltaY: deltaYField,
  timeout: Type.Optional(Type.Number({
    description: 'Timeout in ms for wait, wait_hidden, wait_navigation. Default: 3000.',
  })),
  nth: Type.Optional(Type.Number({
    description: 'Match index (0-based) for "find" action. Default: 0 (first match).',
  })),
  limit: Type.Optional(Type.Number({
    description: 'Max elements to return for "query" action. Default: 20. Use -1 to return all.',
  })),
  frameId: Type.Optional(Type.Number({
    description: 'Frame ID to interact with. Omit for top frame. Use tab({ action: "list_frames" }) to discover IDs.',
  })),
  tabId: Type.Optional(Type.Number({
    description: 'Tab ID to interact with. Omit to use the active tab. Get tab IDs from the context block.',
  })),
  steps: Type.Optional(Type.Array(
    Type.Object({
      action: Type.Union([...stepActions], { description: 'The interaction to perform in this step.' }),
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
  nth?: number;
  limit?: number;
}): Promise<string> {
  const { action, selector, x, y, text, key, modifiers, deltaX, deltaY, timeout = 3000, nth = 0, limit = 20 } = params;

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

    case 'query': {
      if (!selector) throw new Error('"selector" is required for query action.');
      const els = Array.from(document.querySelectorAll<HTMLElement>(selector));
      if (els.length === 0) return Promise.resolve(`No elements found for: ${selector}`);

      const capped = limit < 0 ? els : els.slice(0, limit);
      const elements = capped.map((el, i) => {
        // Build CSS selector path
        const path: string[] = [];
        let node: HTMLElement | null = el;
        while (node && node !== document.body) {
          let seg = node.tagName.toLowerCase();
          if (node.id) {
            seg = '#' + CSS.escape(node.id);
            path.unshift(seg);
            break;
          }
          const siblings = node.parentElement
            ? Array.from(node.parentElement.children).filter(c => c.tagName === node!.tagName)
            : [];
          if (siblings.length > 1) {
            seg += `:nth-of-type(${siblings.indexOf(node) + 1})`;
          }
          path.unshift(seg);
          node = node.parentElement;
        }

        const rect = el.getBoundingClientRect();
        const attrs: Record<string, string> = {};
        for (const attr of el.attributes) {
          attrs[attr.name] = attr.value;
        }

        return {
          index: i,
          tag: el.tagName.toLowerCase(),
          text: el.innerText?.trim().slice(0, 100) || '',
          selector: path.join(' > '),
          attributes: attrs,
          visible: el.offsetParent !== null || el.getClientRects().length > 0,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        };
      });

      return Promise.resolve(JSON.stringify({ count: els.length, elements }, null, 2));
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
    'Simulate user interactions on a browser tab (defaults to the active tab). ' +
    'Actions: click, dblclick, rightclick, hover (target by CSS selector or x/y coordinates), ' +
    'type (text input), clear, select (dropdown), scroll (page or element via selector), keypress, ' +
    'wait (element appears), wait_hidden (element disappears), ' +
    'wait_navigation (page load completes), find (search text in page and return selector), ' +
    'query (get info about elements matching a CSS selector). ' +
    'Use "sequence" with a "steps" array to batch multiple actions in one call ' +
    '(e.g. click → wait → type → keypress). Each step supports the same parameters. ' +
    'Execution stops on the first error and returns all results so far. ' +
    'Elements are scrolled into view automatically before interaction.',
  parameters: InteractParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    const tabId = await resolveTabId(params.tabId);

    // wait_navigation runs in extension context (not in-page)
    if (params.action === 'wait_navigation') {
      try {
        const result = await waitForNavigation(tabId, params.timeout ?? 3000);
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

    // sequence: run multiple steps in order, in-page
    if (params.action === 'sequence') {
      if (!params.steps || params.steps.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: "steps" array is required for sequence action.' }],
          details: { status: 'error' },
        };
      }

      const frameId = params.frameId;
      const results: string[] = [];

      for (let i = 0; i < params.steps.length; i++) {
        signal?.throwIfAborted();
        const step = params.steps[i];

        try {
          const result = await executeInTabWithArgs(tabId, performInteraction, [step], frameId);
          results.push(`[${i + 1}] ${result}`);
        } catch (err) {
          results.push(`[${i + 1}] Error: ${(err as Error).message}`);
          return {
            content: [{ type: 'text', text: `Sequence stopped at step ${i + 1}:\n${results.join('\n')}` }],
            details: { status: 'error' },
          };
        }
      }

      return {
        content: [{ type: 'text', text: `Sequence completed (${params.steps.length} steps):\n${results.join('\n')}` }],
        details: { status: 'done' },
      };
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

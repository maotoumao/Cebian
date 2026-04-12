import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_INTERACT } from '@/lib/types';
import { getActiveTabId, executeInTabWithArgs, waitForNavigation } from './chrome-api';

// ─── Discriminated union: each action has its own parameter shape ───

const ClickParams = Type.Object({
  action: Type.Literal('click'),
  selector: Type.String({ description: 'CSS selector of the element to click.' }),
  frameId: Type.Optional(Type.Number({ description: 'Frame ID. Omit for top frame.' })),
});

const DblclickParams = Type.Object({
  action: Type.Literal('dblclick'),
  selector: Type.String({ description: 'CSS selector of the element to double-click.' }),
  frameId: Type.Optional(Type.Number({ description: 'Frame ID. Omit for top frame.' })),
});

const RightclickParams = Type.Object({
  action: Type.Literal('rightclick'),
  selector: Type.String({ description: 'CSS selector of the element to right-click.' }),
  frameId: Type.Optional(Type.Number({ description: 'Frame ID. Omit for top frame.' })),
});

const HoverParams = Type.Object({
  action: Type.Literal('hover'),
  selector: Type.String({ description: 'CSS selector of the element to hover over.' }),
  frameId: Type.Optional(Type.Number({ description: 'Frame ID. Omit for top frame.' })),
});

const TypeParams = Type.Object({
  action: Type.Literal('type'),
  selector: Type.String({ description: 'CSS selector of the input/textarea to type into.' }),
  text: Type.String({ description: 'Text to type.' }),
  frameId: Type.Optional(Type.Number({ description: 'Frame ID. Omit for top frame.' })),
});

const ClearParams = Type.Object({
  action: Type.Literal('clear'),
  selector: Type.String({ description: 'CSS selector of the input/textarea to clear.' }),
  frameId: Type.Optional(Type.Number({ description: 'Frame ID. Omit for top frame.' })),
});

const SelectParams = Type.Object({
  action: Type.Literal('select'),
  selector: Type.String({ description: 'CSS selector of the <select> element.' }),
  text: Type.String({ description: 'Option text or value to select.' }),
  frameId: Type.Optional(Type.Number({ description: 'Frame ID. Omit for top frame.' })),
});

const ScrollParams = Type.Object({
  action: Type.Literal('scroll'),
  selector: Type.Optional(Type.String({ description: 'CSS selector to scroll. Omit to scroll the page.' })),
  deltaX: Type.Optional(Type.Number({ description: 'Horizontal scroll delta. Default: 0.' })),
  deltaY: Type.Optional(Type.Number({ description: 'Vertical scroll delta. Positive = down. Default: 300.' })),
  frameId: Type.Optional(Type.Number({ description: 'Frame ID. Omit for top frame.' })),
});

const KeypressParams = Type.Object({
  action: Type.Literal('keypress'),
  key: Type.String({ description: 'Key to press (e.g. "Enter", "Tab", "Escape", "ArrowDown").' }),
  modifiers: Type.Optional(Type.Array(
    Type.Union([Type.Literal('ctrl'), Type.Literal('shift'), Type.Literal('alt'), Type.Literal('meta')]),
    { description: 'Modifier keys to hold.' },
  )),
  frameId: Type.Optional(Type.Number({ description: 'Frame ID. Omit for top frame.' })),
});

const WaitParams = Type.Object({
  action: Type.Literal('wait'),
  selector: Type.String({ description: 'CSS selector to wait for.' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in ms. Default: 5000.' })),
  frameId: Type.Optional(Type.Number({ description: 'Frame ID. Omit for top frame.' })),
});

const WaitHiddenParams = Type.Object({
  action: Type.Literal('wait_hidden'),
  selector: Type.String({ description: 'CSS selector to wait until hidden/removed.' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in ms. Default: 5000.' })),
  frameId: Type.Optional(Type.Number({ description: 'Frame ID. Omit for top frame.' })),
});

const WaitNavigationParams = Type.Object({
  action: Type.Literal('wait_navigation'),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in ms. Default: 5000.' })),
});

const InteractParameters = Type.Union([
  ClickParams, DblclickParams, RightclickParams, HoverParams,
  TypeParams, ClearParams, SelectParams, ScrollParams, KeypressParams,
  WaitParams, WaitHiddenParams, WaitNavigationParams,
]);

// ─── In-page interaction function (self-contained) ───

function performInteraction(params: {
  action: string;
  selector?: string;
  text?: string;
  key?: string;
  modifiers?: string[];
  deltaX?: number;
  deltaY?: number;
  timeout?: number;
}): Promise<string> {
  const { action, selector, text, key, modifiers, deltaX, deltaY, timeout = 5000 } = params;

  function getEl(): HTMLElement {
    if (!selector) throw new Error('selector is required for this action.');
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    return el;
  }

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
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ...modInit() }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, ...modInit() }));
      el.click();
      return Promise.resolve(`Clicked: ${selector}`);
    }

    case 'dblclick': {
      const el = getEl();
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return Promise.resolve(`Double-clicked: ${selector}`);
    }

    case 'rightclick': {
      const el = getEl();
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
      return Promise.resolve(`Right-clicked: ${selector}`);
    }

    case 'hover': {
      const el = getEl();
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return Promise.resolve(`Hovered: ${selector}`);
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
    'Actions: click, dblclick, rightclick, hover, type (text input), clear, ' +
    'select (dropdown), scroll, keypress, wait (element appears), ' +
    'wait_hidden (element disappears), wait_navigation (page load completes). ' +
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

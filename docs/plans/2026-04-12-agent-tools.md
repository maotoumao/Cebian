# Agent Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 5 new agent tools (`execute_js`, `read_page`, `interact`, `tab`, `screenshot`) so the Cebian agent can actually interact with browser pages.

**Architecture:** Each tool is an `AgentTool` (from `@mariozechner/pi-agent-core`) with a TypeBox parameter schema, an `execute()` function that calls Chrome extension APIs (`chrome.scripting.executeScript`, `chrome.tabs.*`, `chrome.tabs.captureVisibleTab`), and returns `AgentToolResult`. A shared `getActiveTabId()` utility avoids duplication. Non-interactive tools — they don't pause the agent or show UI. The ChatPage already renders non-interactive tool calls as `ToolCard` (but this is currently not wired — Task 7 fixes that).

**Tech Stack:** TypeScript, `@sinclair/typebox` (parameter schemas), `@mariozechner/pi-agent-core` (AgentTool interface), Chrome Extension APIs (`chrome.scripting`, `chrome.tabs`), WXT.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `lib/tools/helpers.ts` | **New.** Shared utilities: `getActiveTabId()`, `executeInTab()` wrapper |
| `lib/tools/execute-js.ts` | **New.** `execute_js` tool definition |
| `lib/tools/read-page.ts` | **New.** `read_page` tool definition |
| `lib/tools/interact.ts` | **New.** `interact` tool definition |
| `lib/tools/tab.ts` | **New.** `tab` tool definition |
| `lib/tools/screenshot.ts` | **New.** `screenshot` tool definition |
| `lib/tools/index.ts` | **Modify.** Add all 5 new tools to `tools` array |
| `lib/types.ts` | **Modify.** Add tool name constants |
| `lib/constants.ts` | **Modify.** Update system prompt to describe available tools |
| `entrypoints/sidepanel/pages/chat/index.tsx` | **Modify.** Render non-interactive tool calls as `ToolCard` |

---

### Task 1: Shared Helpers

**Files:**
- Create: `lib/tools/helpers.ts`

- [ ] **Step 1: Create helpers file**

```ts
// lib/tools/helpers.ts

/**
 * Build an injection target. If frameId is provided and non-zero, targets that frame.
 */
function buildTarget(tabId: number, frameId?: number): chrome.scripting.InjectionTarget {
  const target: chrome.scripting.InjectionTarget = { tabId };
  if (frameId) target.frameIds = [frameId];
  return target;
}

/**
 * Get the active tab's ID in the current window.
 * Throws if no active tab is found.
 */
export async function getActiveTabId(): Promise<number> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error('No active tab found.');
  return tab.id;
}

/**
 * Execute a function in the active tab (or a specific frame) and return its result.
 * Wraps chrome.scripting.executeScript with error handling.
 */
export async function executeInTab<T>(
  tabId: number,
  func: () => T,
  frameId?: number,
): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: buildTarget(tabId, frameId),
    func,
  });
  const result = results?.[0];
  if (result?.error) {
    throw new Error(result.error.message ?? 'Script execution failed.');
  }
  return result?.result as T;
}

/**
 * Execute a function with serialized arguments in the active tab (or a specific frame).
 * Use when you need to pass parameters into the injected function.
 */
export async function executeInTabWithArgs<TArgs extends any[], T>(
  tabId: number,
  func: (...args: TArgs) => T,
  args: TArgs,
  frameId?: number,
): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: buildTarget(tabId, frameId),
    func,
    args,
  });
  const result = results?.[0];
  if (result?.error) {
    throw new Error(result.error.message ?? 'Script execution failed.');
  }
  return result?.result as T;
}

/**
 * Wait for a tab navigation to complete using chrome.tabs.onUpdated.
 * Used by interact tool's wait_navigation action.
 */
export function waitForNavigation(tabId: number, timeout: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Navigation timeout: ${timeout}ms`));
    }, timeout);
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve('Navigation complete');
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/tools/helpers.ts
git commit -m "feat(tools): add shared helpers for tab/script execution"
```

---

### Task 2: `execute_js` Tool

**Files:**
- Create: `lib/tools/execute-js.ts`
- Modify: `lib/types.ts`
- Modify: `lib/tools/index.ts`

- [ ] **Step 1: Add tool name constant to types.ts**

Add to `lib/types.ts` after the existing constants:

```ts
/** Tool that executes arbitrary JS in the active tab */
export const TOOL_EXECUTE_JS = 'execute_js' as const;
```

Note: Replace the existing `TOOL_EXECUTE_SCRIPT` with `TOOL_EXECUTE_JS` if nothing references `TOOL_EXECUTE_SCRIPT` elsewhere. If it's unused, remove it.

- [ ] **Step 2: Create the tool file**

```ts
// lib/tools/execute-js.ts
import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_EXECUTE_JS } from '@/lib/types';
import { getActiveTabId } from './helpers';

const ExecuteJsParameters = Type.Object({
  code: Type.String({
    description:
      'JavaScript code to execute in the active tab. ' +
      'Wrap in an async IIFE if you need await. ' +
      'The return value will be JSON-serialized and returned.',
  }),
  frameId: Type.Optional(
    Type.Number({
      description:
        'Frame ID to execute in. Omit or 0 for the top frame. ' +
        'Use tab({ action: "list_frames" }) to discover frame IDs.',
    }),
  ),
});

export const executeJsTool: AgentTool<typeof ExecuteJsParameters> = {
  name: TOOL_EXECUTE_JS,
  label: 'Execute JavaScript',
  description:
    'Execute JavaScript code in the active browser tab and return the result. ' +
    'Use for reading DOM properties, extracting data, modifying page content, ' +
    'calling page APIs, or reading localStorage/sessionStorage. ' +
    'The code runs in the page context with full access to the DOM and page globals. ' +
    'Return a value to get it back — it will be JSON-serialized.',
  parameters: ExecuteJsParameters,

  async execute(toolCallId, params): Promise<AgentToolResult> {
    const tabId = await getActiveTabId();

    const target: chrome.scripting.InjectionTarget = { tabId };
    if (params.frameId) target.frameIds = [params.frameId];

    const results = await chrome.scripting.executeScript({
      target,
      func: new Function(`return (async () => { ${params.code} })()`) as () => Promise<unknown>,
      world: 'MAIN',
    });

    const result = results?.[0];
    if (result?.error) {
      return {
        content: [{ type: 'text', text: `Error: ${result.error.message}` }],
        details: { status: 'error' },
      };
    }

    const output = result?.result;
    const text = output === undefined ? '(no return value)' : JSON.stringify(output, null, 2);

    return {
      content: [{ type: 'text', text }],
      details: { status: 'done' },
    };
  },
};
```

**Design note:** `world: 'MAIN'` executes in the page's JS context (access to page globals, frameworks, etc.), not the extension's isolated world. This is necessary for the agent to interact with frameworks (React state, window.fetch, etc.).

- [ ] **Step 3: Register in tools/index.ts**

```ts
// lib/tools/index.ts
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { askUserTool } from './ask-user';
import { executeJsTool } from './execute-js';

// Register interactive tools (side-effect imports)
import './ask-user-registry';

/** All tools available to the Cebian agent. */
export const tools: AgentTool<any>[] = [askUserTool, executeJsTool];
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(tools): implement execute_js tool"
```

---

### Task 3: `read_page` Tool

**Files:**
- Create: `lib/tools/read-page.ts`
- Modify: `lib/types.ts`
- Modify: `lib/tools/index.ts`

- [ ] **Step 1: Add tool name constant**

Add to `lib/types.ts`:

```ts
/** Tool that extracts page content in various formats */
export const TOOL_READ_PAGE = 'read_page' as const;
```

- [ ] **Step 2: Create the tool file**

```ts
// lib/tools/read-page.ts
import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_READ_PAGE } from '@/lib/types';
import { getActiveTabId, executeInTabWithArgs } from './helpers';

const ReadPageParameters = Type.Object({
  mode: Type.Union(
    [
      Type.Literal('text'),
      Type.Literal('html'),
      Type.Literal('readable'),
      Type.Literal('markdown'),
    ],
    {
      description:
        'Extraction mode. ' +
        '"text": plain innerText. ' +
        '"html": cleaned innerHTML (no script/style/svg). ' +
        '"readable": extracts main article content (like Reader Mode). ' +
        '"markdown": readable content converted to markdown.',
      default: 'readable',
    },
  ),
  selector: Type.Optional(
    Type.String({
      description:
        'CSS selector to limit extraction scope. Defaults to document.body.',
    }),
  ),
  maxLength: Type.Optional(
    Type.Number({
      description:
        'Maximum character length of the returned content. Defaults to 20000.',
    }),
  ),
  frameId: Type.Optional(
    Type.Number({
      description:
        'Frame ID to read from. Omit or 0 for the top frame. ' +
        'Use tab({ action: "list_frames" }) to discover frame IDs.',
    }),
  ),
});

/**
 * In-page function that extracts content.
 * Runs inside the tab via chrome.scripting.executeScript.
 */
function extractPageContent(
  mode: string, selector: string | undefined, maxLength: number,
): string {
  const root = selector
    ? document.querySelector(selector)
    : document.body;
  if (!root) return `(no element found for selector: ${selector})`;

  let content: string;

  switch (mode) {
    case 'text':
      content = root.innerText;
      break;

    case 'html': {
      const clone = root.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('script, style, svg, noscript, iframe').forEach(el => el.remove());
      content = clone.innerHTML;
      break;
    }

    case 'readable':
    case 'markdown': {
      // Simplified readability: extract the largest content block
      // or fall back to body text with noise removal.
      const clone = root.cloneNode(true) as HTMLElement;
      // Remove noise elements
      clone.querySelectorAll(
        'script, style, svg, noscript, iframe, nav, header, footer, aside, ' +
        '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
        '.sidebar, .nav, .menu, .footer, .header, .ad, .advertisement, .social-share',
      ).forEach(el => el.remove());

      if (mode === 'markdown') {
        // Convert to markdown-like format
        const lines: string[] = [];
        const walk = (node: Node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            const text = (node.textContent ?? '').trim();
            if (text) lines.push(text);
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const el = node as HTMLElement;
          const tag = el.tagName.toLowerCase();

          if (tag === 'br') { lines.push(''); return; }
          if (['h1','h2','h3','h4','h5','h6'].includes(tag)) {
            const level = parseInt(tag[1]);
            lines.push('');
            lines.push('#'.repeat(level) + ' ' + el.innerText.trim());
            lines.push('');
            return;
          }
          if (tag === 'p') {
            lines.push('');
            el.childNodes.forEach(walk);
            lines.push('');
            return;
          }
          if (tag === 'li') {
            lines.push('- ' + el.innerText.trim());
            return;
          }
          if (tag === 'a') {
            const href = el.getAttribute('href') ?? '';
            lines.push(`[${el.innerText.trim()}](${href})`);
            return;
          }
          if (tag === 'img') {
            const alt = el.getAttribute('alt') ?? '';
            const src = el.getAttribute('src') ?? '';
            if (alt || src) lines.push(`![${alt}](${src})`);
            return;
          }
          if (tag === 'pre' || tag === 'code') {
            lines.push('```');
            lines.push(el.innerText);
            lines.push('```');
            return;
          }
          if (tag === 'blockquote') {
            el.innerText.split('\n').forEach(l => lines.push('> ' + l));
            return;
          }
          if (tag === 'table') {
            const rows = el.querySelectorAll('tr');
            rows.forEach((row, i) => {
              const cells = Array.from(row.querySelectorAll('th, td')).map(c => (c as HTMLElement).innerText.trim());
              lines.push('| ' + cells.join(' | ') + ' |');
              if (i === 0) lines.push('| ' + cells.map(() => '---').join(' | ') + ' |');
            });
            return;
          }
          el.childNodes.forEach(walk);
        };
        walk(clone);
        content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      } else {
        content = clone.innerText;
      }
      break;
    }

    default:
      content = root.innerText;
  }

  if (content.length > maxLength) {
    content = content.slice(0, maxLength) + `\n\n...(truncated at ${maxLength} chars)`;
  }

  return content;
}

export const readPageTool: AgentTool<typeof ReadPageParameters> = {
  name: TOOL_READ_PAGE,
  label: 'Read Page',
  description:
    'Extract content from the current page. ' +
    'Modes: "text" (raw text), "html" (cleaned HTML), ' +
    '"readable" (article extraction, like Reader Mode), ' +
    '"markdown" (article as markdown — best for analysis). ' +
    'Optionally scope to a CSS selector. ' +
    'Use this before answering questions about page content.',
  parameters: ReadPageParameters,

  async execute(toolCallId, params): Promise<AgentToolResult> {
    const tabId = await getActiveTabId();
    const mode = params.mode ?? 'readable';
    const maxLength = params.maxLength ?? 20000;

    const content = await executeInTabWithArgs(
      tabId,
      extractPageContent,
      [mode, params.selector, maxLength],
      params.frameId,
    );

    return {
      content: [{ type: 'text', text: content }],
      details: { status: 'done' },
    };
  },
};
```

- [ ] **Step 3: Add to tools/index.ts**

Add import and append `readPageTool` to the `tools` array.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(tools): implement read_page tool"
```

---

### Task 4: `interact` Tool

**Files:**
- Create: `lib/tools/interact.ts`
- Modify: `lib/types.ts`
- Modify: `lib/tools/index.ts`

- [ ] **Step 1: Add tool name constant**

Add to `lib/types.ts`:

```ts
/** Tool that simulates user interactions on the page */
export const TOOL_INTERACT = 'interact' as const;
```

- [ ] **Step 2: Create the tool file**

```ts
// lib/tools/interact.ts
import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_INTERACT } from '@/lib/types';
import { getActiveTabId, executeInTabWithArgs, waitForNavigation } from './helpers';

const InteractParameters = Type.Object({
  action: Type.Union(
    [
      Type.Literal('click'),
      Type.Literal('dblclick'),
      Type.Literal('rightclick'),
      Type.Literal('hover'),
      Type.Literal('type'),
      Type.Literal('clear'),
      Type.Literal('select'),
      Type.Literal('scroll'),
      Type.Literal('keypress'),
      Type.Literal('wait'),
      Type.Literal('wait_hidden'),
      Type.Literal('wait_navigation'),
    ],
    { description: 'The user interaction to simulate.' },
  ),
  selector: Type.Optional(
    Type.String({ description: 'CSS selector of the target element.' }),
  ),
  text: Type.Optional(
    Type.String({
      description: 'Text to type (for "type" action) or option text to select (for "select" action).',
    }),
  ),
  key: Type.Optional(
    Type.String({
      description:
        'Key to press for "keypress" action (e.g. "Enter", "Tab", "Escape", "ArrowDown").',
    }),
  ),
  modifiers: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal('ctrl'),
        Type.Literal('shift'),
        Type.Literal('alt'),
        Type.Literal('meta'),
      ]),
      { description: 'Modifier keys to hold during the action.' },
    ),
  ),
  deltaX: Type.Optional(
    Type.Number({ description: 'Horizontal scroll delta (for "scroll" action).' }),
  ),
  deltaY: Type.Optional(
    Type.Number({ description: 'Vertical scroll delta (for "scroll" action). Positive = down.' }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description: 'Timeout in ms for "wait"/"wait_hidden"/"wait_navigation" actions. Default: 5000.',
    }),
  ),
  frameId: Type.Optional(
    Type.Number({
      description:
        'Frame ID to interact with. Omit or 0 for the top frame. ' +
        'Use tab({ action: "list_frames" }) to discover frame IDs.',
    }),
  ),
});

/**
 * In-page function that performs the interaction.
 * Runs inside the tab via chrome.scripting.executeScript.
 */
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

  function buildModifierInit(): { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean } {
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
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ...buildModifierInit() }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, ...buildModifierInit() }));
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
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      return Promise.resolve(`Hovered: ${selector}`);
    }

    case 'type': {
      const el = getEl();
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.focus();
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        // Use native setter to work with React/Vue controlled inputs
        const nativeSetter = Object.getOwnPropertyDescriptor(
          el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          'value',
        )?.set;
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
        const nativeSetter = Object.getOwnPropertyDescriptor(
          el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          'value',
        )?.set;
        if (nativeSetter) {
          nativeSetter.call(el, '');
        } else {
          el.value = '';
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return Promise.resolve(`Cleared: ${selector}`);
    }

    case 'select': {
      const el = getEl();
      if (el instanceof HTMLSelectElement) {
        const option = Array.from(el.options).find(o => o.text === text || o.value === text);
        if (!option) throw new Error(`Option not found: ${text}`);
        el.value = option.value;
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
      const init: KeyboardEventInit = { key, bubbles: true, ...buildModifierInit() };
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
      return new Promise<string>((resolve, reject) => {
        if (!document.querySelector(selector)) { resolve(`Element already hidden: ${selector}`); return; }
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`Timeout: element ${selector} still visible after ${timeout}ms`));
        }, timeout);
        const observer = new MutationObserver(() => {
          if (!document.querySelector(selector)) {
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

export const interactTool: AgentTool<typeof InteractParameters> = {
  name: TOOL_INTERACT,
  label: 'Interact',
  description:
    'Simulate user interactions on the active page. ' +
    'Actions: click, dblclick, rightclick, hover, type (text input), clear, ' +
    'select (dropdown), scroll, keypress, wait (element appears), wait_hidden (element disappears), ' +
    'wait_navigation (page load completes after navigation). ' +
    'Always specify a CSS selector to target the element. ' +
    'Elements are scrolled into view automatically before interaction.',
  parameters: InteractParameters,

  async execute(toolCallId, params): Promise<AgentToolResult> {
    const tabId = await getActiveTabId();

    // wait_navigation runs in extension context, not in-page
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

    try {
      const result = await executeInTabWithArgs(tabId, performInteraction, [params], params.frameId);

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
```

**Design notes:**
- Uses JS-level simulation (`el.click()`, `el.dispatchEvent`) — no CDP `Input` domain needed, no debugger attach, no yellow bar.
- `type` action uses native input setter trick to work with React/Vue controlled inputs that ignore direct `.value` assignment.
- `wait`/`wait_hidden` use MutationObserver with timeout.
- `wait_navigation` runs in extension context (not in-page) using `chrome.tabs.onUpdated`, since in-page scripts are destroyed on navigation.
- All in-page actions support `frameId` to target iframes.

- [ ] **Step 3: Add to tools/index.ts**

Add import and append `interactTool` to the `tools` array.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(tools): implement interact tool"
```

---

### Task 5: `tab` Tool

**Files:**
- Create: `lib/tools/tab.ts`
- Modify: `lib/types.ts`
- Modify: `lib/tools/index.ts`

- [ ] **Step 1: Add tool name constant**

Add to `lib/types.ts`:

```ts
/** Tool that manages browser tabs */
export const TOOL_TAB = 'tab' as const;
```

- [ ] **Step 2: Create the tool file**

```ts
// lib/tools/tab.ts
import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_TAB } from '@/lib/types';
import { getActiveTabId } from './helpers';

const TabParameters = Type.Object({
  action: Type.Union(
    [
      Type.Literal('open'),
      Type.Literal('close'),
      Type.Literal('switch'),
      Type.Literal('reload'),
      Type.Literal('list_frames'),
    ],
    { description: 'The tab action to perform.' },
  ),
  url: Type.Optional(
    Type.String({ description: 'URL to open (required for "open" action).' }),
  ),
  tabId: Type.Optional(
    Type.Number({
      description:
        'Tab ID for close/switch/reload. Get tab IDs from the context block ' +
        'or by listing tabs. If omitted for "reload", reloads the active tab.',
    }),
  ),
});

export const tabTool: AgentTool<typeof TabParameters> = {
  name: TOOL_TAB,
  label: 'Manage Tab',
  description:
    'Manage browser tabs: open a new tab, close a tab, switch to a tab, reload, ' +
    'or list all frames (including iframes) in the active tab. ' +
    'Use the tab list from the context block to find tab IDs.',
  parameters: TabParameters,

  async execute(toolCallId, params): Promise<AgentToolResult> {
    switch (params.action) {
      case 'open': {
        if (!params.url) {
          return {
            content: [{ type: 'text', text: 'Error: "url" is required for open action.' }],
            details: { status: 'error' },
          };
        }
        const tab = await chrome.tabs.create({ url: params.url });
        return {
          content: [{ type: 'text', text: `Opened new tab (id: ${tab.id}): ${params.url}` }],
          details: { status: 'done' },
        };
      }

      case 'close': {
        if (!params.tabId) {
          return {
            content: [{ type: 'text', text: 'Error: "tabId" is required for close action.' }],
            details: { status: 'error' },
          };
        }
        await chrome.tabs.remove(params.tabId);
        return {
          content: [{ type: 'text', text: `Closed tab: ${params.tabId}` }],
          details: { status: 'done' },
        };
      }

      case 'switch': {
        if (!params.tabId) {
          return {
            content: [{ type: 'text', text: 'Error: "tabId" is required for switch action.' }],
            details: { status: 'error' },
          };
        }
        await chrome.tabs.update(params.tabId, { active: true });
        const tab = await chrome.tabs.get(params.tabId);
        return {
          content: [{ type: 'text', text: `Switched to tab: ${tab.title ?? tab.url}` }],
          details: { status: 'done' },
        };
      }

      case 'reload': {
        const tabId = params.tabId
          ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        if (!tabId) {
          return {
            content: [{ type: 'text', text: 'Error: no tab to reload.' }],
            details: { status: 'error' },
          };
        }
        await chrome.tabs.reload(tabId);
        return {
          content: [{ type: 'text', text: `Reloaded tab: ${tabId}` }],
          details: { status: 'done' },
        };
      }

      case 'list_frames': {
        const tabId = await getActiveTabId();
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => ({
              url: window.location.href,
              title: document.title,
              isTop: window === window.top,
            }),
          });
          const frames = results.map(r => ({
            frameId: r.frameId,
            ...r.result,
          }));
          return {
            content: [{ type: 'text', text: JSON.stringify(frames, null, 2) }],
            details: { status: 'done' },
          };
        } catch {
          return {
            content: [{ type: 'text', text: 'Error: cannot list frames (page may be restricted).' }],
            details: { status: 'error' },
          };
        }
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown action: ${params.action}` }],
          details: { status: 'error' },
        };
    }
  },
};
```

**Design note:** `tab` tool does NOT need tab IDs in `<cebian-context>` — the context block currently shows URL + title but NOT tab IDs. We need to update `lib/page-context.ts` to include tab IDs so the agent can reference them. This is handled in Task 8.

- [ ] **Step 3: Add to tools/index.ts**

Add import and append `tabTool` to the `tools` array.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(tools): implement tab tool"
```

---

### Task 6: `screenshot` Tool

**Files:**
- Create: `lib/tools/screenshot.ts`
- Modify: `lib/types.ts`
- Modify: `lib/tools/index.ts`

- [ ] **Step 1: Add tool name constant**

Add to `lib/types.ts`:

```ts
/** Tool that captures a screenshot of the active tab */
export const TOOL_SCREENSHOT = 'screenshot' as const;
```

- [ ] **Step 2: Create the tool file**

```ts
// lib/tools/screenshot.ts
import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_SCREENSHOT } from '@/lib/types';

const ScreenshotParameters = Type.Object({
  quality: Type.Optional(
    Type.Number({
      description: 'JPEG quality (1-100). Default: 80.',
      minimum: 1,
      maximum: 100,
    }),
  ),
});

export const screenshotTool: AgentTool<typeof ScreenshotParameters> = {
  name: TOOL_SCREENSHOT,
  label: 'Screenshot',
  description:
    'Capture a screenshot of the current visible area of the active tab. ' +
    'Returns the image for visual analysis. ' +
    'Use this to see what the page looks like, verify UI state, or analyze layout.',
  parameters: ScreenshotParameters,

  async execute(toolCallId, params): Promise<AgentToolResult> {
    const quality = params.quality ?? 80;

    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, {
      format: 'jpeg',
      quality,
    });

    // Extract base64 data from data URL
    const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');

    return {
      content: [
        {
          type: 'image',
          source: { type: 'base64', mediaType: 'image/jpeg', data: base64 },
        } as any, // pi-ai ImageContent uses this shape
      ],
      details: { status: 'done' },
    };
  },
};
```

**Design notes:**
- Uses `chrome.tabs.captureVisibleTab()` — no CDP needed, no debugger yellow bar.
- Returns `ImageContent` for the LLM to see. The `as any` is needed because `AgentToolResult.content` is typed as `TextContent[]` but the LLM accepts image content blocks.
- `fullPage` and `selector` screenshot modes are deferred — they need CDP `Page.captureScreenshot` with viewport manipulation.

- [ ] **Step 3: Add to tools/index.ts**

Add import and append `screenshotTool` to the `tools` array.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(tools): implement screenshot tool"
```

---

### Task 7: Wire Non-Interactive Tool Calls in ChatPage

**Files:**
- Modify: `entrypoints/sidepanel/pages/chat/index.tsx`

Currently, ChatPage only renders interactive tools (via registry). Non-interactive tool calls (execute_js, read_page, interact, tab, screenshot) are invisible. We need to render them as `ToolCard` components.

- [ ] **Step 1: Import ToolCard and add rendering logic**

In `entrypoints/sidepanel/pages/chat/index.tsx`, add import at the top:

```ts
import { ToolCard } from '@/components/chat/ToolCard';
```

Then in the assistant message rendering section, after the interactive tool rendering block, add non-interactive tool card rendering. Replace the `{toolCalls.map((tc) => { ... })}` block with:

```tsx
{toolCalls.map((tc) => {
  const info = getInteractiveToolInfo(tc.name);

  // Interactive tool — render via registry
  if (info) {
    const pending = getPendingFor(tc.name);
    const isPending = pending?.toolCallId === tc.id;
    const toolResult = findToolResult(messages, tc.id);
    return (
      <info.Component
        key={`tool-${tc.id}`}
        toolCallId={tc.id}
        args={tc.arguments}
        isPending={isPending}
        toolResult={toolResult}
        onResolve={isPending ? (response: any) => resolve(tc.name, response) : undefined}
      />
    );
  }

  // Non-interactive tool — render as ToolCard
  const toolResult = findToolResult(messages, tc.id);
  const status = toolResult
    ? (toolResult.isError ? 'error' : 'done')
    : 'running';
  const code = JSON.stringify(tc.arguments, null, 2);
  return (
    <ToolCard
      key={`tool-${tc.id}`}
      name={tc.name}
      status={status}
      code={code}
    />
  );
})}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat(chat): render non-interactive tool calls as ToolCard"
```

---

### Task 8: Add Tab IDs to Page Context

**Files:**
- Modify: `lib/page-context.ts`

The `tab` tool needs tab IDs to switch/close tabs, but `<cebian-context>` currently only shows title + URL. Add tab IDs.

- [ ] **Step 1: Update tab list format**

In `lib/page-context.ts`, change the tab list formatting from:

```ts
for (const tab of tabs) {
  const marker = tab.id === activeTab.id ? '* ' : '  ';
  lines.push(`${marker}${tab.title ?? ''} | ${tab.url ?? ''}`);
}
```

To:

```ts
for (const tab of tabs) {
  const marker = tab.id === activeTab.id ? '* ' : '  ';
  lines.push(`${marker}[${tab.id}] ${tab.title ?? ''} | ${tab.url ?? ''}`);
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat(context): include tab IDs in page context"
```

---

### Task 9: Update System Prompt

**Files:**
- Modify: `lib/constants.ts`

- [ ] **Step 1: Update DEFAULT_SYSTEM_PROMPT to describe available tools**

Replace the capabilities section of the system prompt with an updated version that accurately describes the real tools:

```ts
export const DEFAULT_SYSTEM_PROMPT = `You are Cebian, an AI assistant embedded in a Chrome browser extension sidebar.

You can see and interact with the user's current browser tab using the following tools:

- **execute_js**: Run JavaScript in the active tab (or a specific iframe). Use for reading DOM, extracting data, calling page APIs, or any custom logic.
- **read_page**: Extract page content in various formats (text, html, readable, markdown). Use "markdown" mode for page analysis. Always call this before summarizing or analyzing a page.
- **interact**: Simulate user actions — click, type, scroll, hover, wait for elements, wait_navigation (after link clicks), etc. Always use a CSS selector to target elements.
- **tab**: Manage browser tabs — open, close, switch, reload, list_frames (discover iframes). Use tab IDs from the context block.
- **screenshot**: Capture visible area of the active tab for visual analysis.
- **ask_user**: Ask the user a clarifying question when you need more information.

Each user message is automatically preceded by a <cebian-context> block containing:
- The active tab's URL, title, and page metadata (description, keywords, lang, etc.)
- Any text the user has selected on the page
- A list of all open tabs with their IDs in the current window (the active tab is marked with *)
Use this context to understand what the user is looking at. When they say "this page" or "当前页面", refer to the Active Tab. Do not mention the context block to the user — it is injected automatically and invisible to them.

Guidelines:
- Before answering questions about page content, always read_page first.
- For multi-step page interactions, use interact with wait/wait_navigation between actions.
- To interact with content inside iframes, first use tab({ action: "list_frames" }) to get frame IDs, then pass frameId to execute_js / read_page / interact.
- Be concise and precise. Prefer Chinese for responses unless the user writes in English.`;
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: update system prompt with tool descriptions"
```

---

### Task 10: Final tools/index.ts Assembly

**Files:**
- Modify: `lib/tools/index.ts`

- [ ] **Step 1: Final state of tools/index.ts**

```ts
// lib/tools/index.ts
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { askUserTool } from './ask-user';
import { executeJsTool } from './execute-js';
import { readPageTool } from './read-page';
import { interactTool } from './interact';
import { tabTool } from './tab';
import { screenshotTool } from './screenshot';

// Register interactive tools (side-effect imports)
import './ask-user-registry';

/** All tools available to the Cebian agent. */
export const tools: AgentTool<any>[] = [
  askUserTool,
  executeJsTool,
  readPageTool,
  interactTool,
  tabTool,
  screenshotTool,
];
```

- [ ] **Step 2: Clean up lib/types.ts**

Final state of tool constants in `lib/types.ts`:

```ts
// ─── Tool name constants ───
export const TOOL_ASK_USER = 'ask_user' as const;
export const TOOL_EXECUTE_JS = 'execute_js' as const;
export const TOOL_READ_PAGE = 'read_page' as const;
export const TOOL_INTERACT = 'interact' as const;
export const TOOL_TAB = 'tab' as const;
export const TOOL_SCREENSHOT = 'screenshot' as const;
```

Remove the old `TOOL_EXECUTE_SCRIPT` if nothing references it.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(tools): register all 6 tools in tools array"
```

---

## Summary

| Task | Files | Description |
|------|-------|-------------|
| 1 | `lib/tools/helpers.ts` (new) | Shared `getActiveTabId()` + `executeInTab()` |
| 2 | `lib/tools/execute-js.ts` (new) | `execute_js` tool |
| 3 | `lib/tools/read-page.ts` (new) | `read_page` tool with 4 modes + frameId |
| 4 | `lib/tools/interact.ts` (new) | `interact` tool with 12 actions + frameId |
| 5 | `lib/tools/tab.ts` (new) | `tab` tool with 5 actions (incl. list_frames) |
| 6 | `lib/tools/screenshot.ts` (new) | `screenshot` tool |
| 7 | `pages/chat/index.tsx` (modify) | Render non-interactive tools as ToolCard |
| 8 | `lib/page-context.ts` (modify) | Add tab IDs to context |
| 9 | `lib/constants.ts` (modify) | Update system prompt |
| 10 | `lib/tools/index.ts` + `lib/types.ts` (modify) | Final assembly + cleanup |

5 new files, 5 modified files, 10 tasks.

---

Plan saved. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session sequentially with checkpoints

Which approach?
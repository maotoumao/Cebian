# Tool System Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve 5 aspects of the tool system: clarify execute_js return semantics, add window ID to context & tab tool, add batch interact steps, add region screenshot, and support scroll-to-selector.

**Architecture:** Each improvement is independent and touches specific files. Changes span tool definitions, system prompt, page context, and offscreen document (for image cropping). No new files needed except extending the offscreen document's message types.

**Tech Stack:** TypeScript, Chrome Extension APIs (`chrome.tabs`, `chrome.windows`, `chrome.scripting`, `chrome.tabs.captureVisibleTab`), Typebox schemas, OffscreenCanvas for image cropping.

---

## File Map

| File | Changes |
|------|---------|
| `lib/tools/execute-js.ts` | Clarify description for return semantics |
| `lib/constants.ts` | Update system prompt for execute_js guidance |
| `lib/page-context.ts` | Add window ID, group tabs by window |
| `lib/tools/tab.ts` | Add `windowId` param to `open` action |
| `lib/tools/interact.ts` | Add `sequence` action; scroll already supports selector (confirm) |
| `lib/tools/screenshot.ts` | Add `selector` and `clip` params |
| `entrypoints/offscreen/main.ts` | Add `crop-image` message handler |
| `lib/constants.ts` | Update system prompt for new capabilities |

---

### Task 1: Clarify execute_js return semantics

**Files:**
- Modify: `lib/tools/execute-js.ts:3-8` (description)
- Modify: `lib/constants.ts:44-47` (system prompt — execute_js section)

- [ ] **Step 1.1: Update execute_js tool description**

In `lib/tools/execute-js.ts`, change the `code` parameter description and the tool-level description to explicitly state the code is an async function body and `return` is how to produce a result:

```ts
const ExecuteJsParameters = Type.Object({
  code: Type.String({
    description:
      'JavaScript code to execute in the active tab. ' +
      'The code is the body of an async function — use `return` to produce a result ' +
      '(e.g. `return document.title`). You can use `await` directly. ' +
      'The return value will be JSON-serialized.',
  }),
  frameId: Type.Optional(
    Type.Number({
      description:
        'Frame ID to execute in. Omit or 0 for the top frame. ' +
        'Use tab({ action: "list_frames" }) to discover frame IDs.',
    }),
  ),
});
```

And the tool-level description:

```ts
  description:
    'Execute JavaScript code in the active browser tab and return the result. ' +
    'The code runs as an async function body — use `return` to produce output (e.g. `return document.title`). ' +
    'Use for DOM operations, data extraction, page modifications, ' +
    'calling page APIs, or reading localStorage/sessionStorage. ' +
    'The code runs in the page context with full access to the DOM and page globals.',
```

- [ ] **Step 1.2: Update system prompt's execute_js section**

In `lib/constants.ts`, update the `execute_js` bullet in `DEFAULT_SYSTEM_PROMPT`:

```
- **execute_js**: Run JavaScript in the active tab (or a specific iframe via frameId). The code is the body of an async function — use \`return\` to produce a result (e.g. \`return document.title\`). You can use await directly. Use for calling page APIs, modifying page content, or complex logic that other tools cannot handle.
```

- [ ] **Step 1.3: Commit**

```bash
git add lib/tools/execute-js.ts lib/constants.ts
git commit -m "docs: clarify execute_js return semantics in description and system prompt"
```

---

### Task 2: Add window ID to page context + tab tool windowId param

**Files:**
- Modify: `lib/page-context.ts` (restructure to show windows, expose window ID)
- Modify: `lib/tools/tab.ts` (add `windowId` param to `open` action)
- Modify: `lib/constants.ts` (update system prompt for window awareness)

- [ ] **Step 2.1: Restructure page context to show window IDs**

Replace the `gatherPageContext()` function in `lib/page-context.ts`:

```ts
export async function gatherPageContext(): Promise<string> {
  const allWindows = await chrome.windows.getAll({ populate: true });
  const currentWindow = allWindows.find(w => w.focused);

  if (!allWindows.length) return '';

  // Find the active tab across all windows (prefer focused window)
  const activeTab = currentWindow?.tabs?.find(t => t.active)
    ?? allWindows.flatMap(w => w.tabs ?? []).find(t => t.active);

  if (!activeTab) return '';

  const meta = activeTab.id != null ? await getActiveTabMeta(activeTab.id) : {};

  const lines: string[] = [];

  // Active tab details
  lines.push(`[Active Tab] ${activeTab.title ?? ''} | ${activeTab.url ?? ''}`);
  lines.push(`  windowId: ${activeTab.windowId}`);
  if (meta.description) lines.push(`  description: ${meta.description}`);
  if (meta.keywords) lines.push(`  keywords: ${meta.keywords}`);
  if (meta.canonical) lines.push(`  canonical: ${meta.canonical}`);
  if (meta.ogType) lines.push(`  og:type: ${meta.ogType}`);
  if (meta.lang) lines.push(`  lang: ${meta.lang}`);
  if (meta.selectedText) lines.push(`  selected_text: "${meta.selectedText}"`);

  // All windows and their tabs
  lines.push('');
  for (const win of allWindows) {
    const tabs = win.tabs ?? [];
    const focusedMarker = win.focused ? ' (focused)' : '';
    lines.push(`[Window ${win.id}]${focusedMarker} (${tabs.length} tabs)`);
    for (const tab of tabs) {
      const marker = tab.id === activeTab.id ? '* ' : '  ';
      lines.push(`${marker}[${tab.id}] ${tab.title ?? ''} | ${tab.url ?? ''}`);
    }
  }

  return `${CONTEXT_TAG_OPEN}\n${lines.join('\n')}\n${CONTEXT_TAG_CLOSE}`;
}
```

- [ ] **Step 2.2: Add windowId param to tab tool's open action**

In `lib/tools/tab.ts`, add `windowId` to `TabParameters`:

```ts
const TabParameters = Type.Object({
  action: Type.Union([
    Type.Literal('open'), Type.Literal('close'), Type.Literal('switch'),
    Type.Literal('reload'), Type.Literal('list_frames'),
  ], { description: 'The tab action to perform.' }),
  url: Type.Optional(Type.String({
    description: 'URL to open. Required for "open" action (http/https only).',
  })),
  tabId: Type.Optional(Type.Number({
    description: 'Tab ID. Required for "close" and "switch". Optional for "reload" (omit to reload active tab). Get IDs from the context block.',
  })),
  windowId: Type.Optional(Type.Number({
    description: 'Window ID for the "open" action. Omit to use the current focused window. Get window IDs from the context block.',
  })),
});
```

Then update the `open` case to pass `windowId`:

```ts
        case 'open': {
          if (!params.url) {
            return { content: [{ type: 'text', text: 'Error: "url" is required for open action.' }], details: { status: 'error' } };
          }
          const parsed = new URL(params.url);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            return {
              content: [{ type: 'text', text: `Error: only http/https URLs are allowed. Got: ${parsed.protocol}` }],
              details: { status: 'error' },
            };
          }
          const createProps: chrome.tabs.CreateProperties = { url: params.url };
          if (params.windowId != null) createProps.windowId = params.windowId;
          const tab = await chrome.tabs.create(createProps);
          return {
            content: [{ type: 'text', text: `Opened new tab (id: ${tab.id}) in window ${tab.windowId}: ${params.url}` }],
            details: { status: 'done' },
          };
        }
```

- [ ] **Step 2.3: Update system prompt for window awareness**

In `lib/constants.ts`, update the context block description and tab tool description in `DEFAULT_SYSTEM_PROMPT`:

For the context description section:
```
Each user message is automatically preceded by a <cebian-context> block containing:
- The active tab's URL, title, page metadata, and its windowId
- Any text the user has selected on the page
- All open windows with their window IDs, and all tabs in each window (the active tab is marked with *)
Use this context to understand what the user is looking at. When opening new tabs, prefer using the active tab's windowId unless the user specifies otherwise.
```

For the tab tool description:
```
- **tab**: Manage browser tabs — open (http/https only, optionally specify windowId), close, switch, reload, or list_frames. Use this to navigate to any website. Prefer using the active tab's windowId from context when opening tabs.
```

- [ ] **Step 2.4: Commit**

```bash
git add lib/page-context.ts lib/tools/tab.ts lib/constants.ts
git commit -m "feat: add window ID to page context and tab open action"
```

---

### Task 3: Add `sequence` action to interact tool

**Files:**
- Modify: `lib/tools/interact.ts` (add `sequence` action type + `steps` parameter + execution logic)
- Modify: `lib/constants.ts` (update system prompt for sequence action)

- [ ] **Step 3.1: Add `steps` parameter and `sequence` to action union**

In `lib/tools/interact.ts`, extend the `InteractParameters`:

Add `'sequence'` to the action union:

```ts
  action: Type.Union([
    Type.Literal('click'), Type.Literal('dblclick'), Type.Literal('rightclick'),
    Type.Literal('hover'), Type.Literal('type'), Type.Literal('clear'),
    Type.Literal('select'), Type.Literal('scroll'), Type.Literal('keypress'),
    Type.Literal('wait'), Type.Literal('wait_hidden'), Type.Literal('wait_navigation'),
    Type.Literal('find'), Type.Literal('query'), Type.Literal('sequence'),
  ], { description: 'The interaction to perform.' }),
```

Add the `steps` parameter after the existing params (before `frameId`):

```ts
  steps: Type.Optional(Type.Array(
    Type.Object({
      action: Type.Union([
        Type.Literal('click'), Type.Literal('dblclick'), Type.Literal('rightclick'),
        Type.Literal('hover'), Type.Literal('type'), Type.Literal('clear'),
        Type.Literal('select'), Type.Literal('scroll'), Type.Literal('keypress'),
        Type.Literal('wait'), Type.Literal('wait_hidden'),
      ], { description: 'The interaction to perform in this step.' }),
      selector: Type.Optional(Type.String({ description: 'CSS selector of the target element.' })),
      x: Type.Optional(Type.Number({ description: 'X viewport coordinate.' })),
      y: Type.Optional(Type.Number({ description: 'Y viewport coordinate.' })),
      text: Type.Optional(Type.String({ description: 'Text content for type/select/find.' })),
      key: Type.Optional(Type.String({ description: 'Key name for keypress.' })),
      modifiers: Type.Optional(Type.Array(Type.String(), { description: 'Modifier keys.' })),
      deltaX: Type.Optional(Type.Number({ description: 'Horizontal scroll amount.' })),
      deltaY: Type.Optional(Type.Number({ description: 'Vertical scroll amount.' })),
      timeout: Type.Optional(Type.Number({ description: 'Timeout in ms for wait/wait_hidden.' })),
    }),
    {
      description:
        'Array of interaction steps to execute sequentially. Required for "sequence" action. ' +
        'Each step can be any single-element action (click, type, wait, etc.). ' +
        'Execution stops on the first error.',
    },
  )),
```

- [ ] **Step 3.2: Add sequence execution logic in the tool's execute method**

In the `execute` method of `interactTool` (in `lib/tools/interact.ts`), add handling for `sequence` before the generic in-page fallthrough. Insert after the `wait_navigation` block:

```ts
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

        // wait_hidden/wait use timeouts, run in-page
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
```

- [ ] **Step 3.3: Update system prompt with sequence action**

In `lib/constants.ts`, add the sequence action to the interact section of `DEFAULT_SYSTEM_PROMPT`:

```
  - sequence — execute multiple steps in order in a single tool call. Provide a "steps" array where each step is an action (click, type, wait, scroll, keypress, etc.). Execution stops on the first error. Use this for multi-step workflows like "click a button, wait for an element, type text, press Enter".
```

Also update the guideline about multi-step interactions:

```
- For multi-step page interactions, prefer interact({ action: "sequence", steps: [...] }) to batch actions in a single tool call. Use wait/wait_hidden steps between actions when timing matters.
```

- [ ] **Step 3.4: Commit**

```bash
git add lib/tools/interact.ts lib/constants.ts
git commit -m "feat: add sequence action to interact tool for batch operations"
```

---

### Task 4: Add region screenshot (selector + clip)

**Files:**
- Modify: `lib/tools/screenshot.ts` (add `selector` and `clip` params, cropping logic)
- Modify: `entrypoints/offscreen/main.ts` (add `crop-image` handler)
- Modify: `lib/constants.ts` (update system prompt)

- [ ] **Step 4.1: Add crop-image handler to offscreen document**

In `entrypoints/offscreen/main.ts`, extend the message types and add a crop handler:

Add the new request/response type to the existing types:

```ts
export interface OffscreenRequest {
  type: 'html-to-markdown' | 'crop-image';
  html: string;
  /** If provided, run Readability before markdown conversion. */
  readability?: { url: string };
  /** For crop-image: base64 JPEG image data. */
  imageData?: string;
  /** For crop-image: crop region in CSS pixels. */
  crop?: { x: number; y: number; width: number; height: number };
}
```

Add the crop function before the message listener:

```ts
async function cropImage(base64: string, crop: { x: number; y: number; width: number; height: number }): Promise<string> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to load image for cropping'));
    img.src = `data:image/jpeg;base64,${base64}`;
  });

  const canvas = document.createElement('canvas');
  canvas.width = crop.width;
  canvas.height = crop.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  return dataUrl.replace(/^data:image\/jpeg;base64,/, '');
}
```

Update the message listener to handle `crop-image`:

```ts
chrome.runtime.onMessage.addListener(
  (message: OffscreenRequest, _sender, sendResponse) => {
    if (message.type === 'crop-image') {
      if (!message.imageData || !message.crop) {
        sendResponse({ error: 'imageData and crop are required' } satisfies OffscreenResponse);
        return true;
      }
      cropImage(message.imageData, message.crop)
        .then(result => sendResponse({ result } satisfies OffscreenResponse))
        .catch(err => sendResponse({ error: err.message } satisfies OffscreenResponse));
      return true;
    }

    if (message.type !== 'html-to-markdown') return;

    // ... existing html-to-markdown logic unchanged ...
```

- [ ] **Step 4.2: Update screenshot tool with selector and clip params**

Replace the full content of `lib/tools/screenshot.ts`:

```ts
import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_SCREENSHOT } from '@/lib/types';
import { getActiveTabId, executeInTabWithArgs } from './chrome-api';
import type { OffscreenRequest, OffscreenResponse } from '@/entrypoints/offscreen/main';

const ScreenshotParameters = Type.Object({
  quality: Type.Optional(
    Type.Number({
      description: 'JPEG quality (1-100). Default: 80.',
      minimum: 1,
      maximum: 100,
    }),
  ),
  selector: Type.Optional(
    Type.String({
      description:
        'CSS selector — capture only this element\'s visible bounding rect. ' +
        'The element is scrolled into view before capture. Takes priority over clip.',
    }),
  ),
  clip: Type.Optional(
    Type.Object({
      x: Type.Number({ description: 'X offset from viewport left (px).' }),
      y: Type.Number({ description: 'Y offset from viewport top (px).' }),
      width: Type.Number({ description: 'Region width (px).' }),
      height: Type.Number({ description: 'Region height (px).' }),
    }, {
      description: 'Viewport region to capture (pixels). Ignored if selector is provided.',
    }),
  ),
});

/** Get the device pixel ratio and bounding rect of a selector in the active tab. */
function getElementRect(selector: string): { x: number; y: number; width: number; height: number; dpr: number } | null {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return null;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    dpr: window.devicePixelRatio ?? 1,
  };
}

async function ensureOffscreenDocument(): Promise<void> {
  const contexts = await (chrome.runtime as any).getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/index.html',
    reasons: [chrome.offscreen.Reason.DOM_PARSER],
    justification: 'Image cropping requires Canvas API',
  });
}

async function cropViaOffscreen(base64: string, crop: { x: number; y: number; width: number; height: number; dpr: number }): Promise<string> {
  await ensureOffscreenDocument();
  // Scale crop coordinates by device pixel ratio (captureVisibleTab returns physical pixels)
  const dpr = crop.dpr;
  const scaledCrop = {
    x: Math.round(crop.x * dpr),
    y: Math.round(crop.y * dpr),
    width: Math.round(crop.width * dpr),
    height: Math.round(crop.height * dpr),
  };
  const resp: OffscreenResponse = await chrome.runtime.sendMessage({
    type: 'crop-image',
    imageData: base64,
    crop: scaledCrop,
  } satisfies OffscreenRequest);
  if (resp.error) throw new Error(`Crop failed: ${resp.error}`);
  return resp.result!;
}

export const screenshotTool: AgentTool<typeof ScreenshotParameters> = {
  name: TOOL_SCREENSHOT,
  label: 'Screenshot',
  description:
    'Capture a screenshot of the active tab. ' +
    'By default captures the full visible area. ' +
    'Provide a CSS selector to capture only a specific element, ' +
    'or a clip region {x, y, width, height} for a viewport sub-area. ' +
    'Returns the image for visual analysis.',
  parameters: ScreenshotParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    const quality = params.quality ?? 80;

    // Determine crop region
    let crop: { x: number; y: number; width: number; height: number; dpr: number } | null = null;

    if (params.selector) {
      const tabId = await getActiveTabId();
      const rect = await executeInTabWithArgs(tabId, getElementRect, [params.selector]);
      if (!rect) {
        return {
          content: [{ type: 'text', text: `Error: element not found: ${params.selector}` }],
          details: { status: 'error' },
        };
      }
      crop = rect;
    } else if (params.clip) {
      crop = { ...params.clip, dpr: 1 };
      // We don't know the DPR without injecting into the page; get it
      const tabId = await getActiveTabId();
      const dpr = await executeInTabWithArgs(tabId, () => window.devicePixelRatio ?? 1, []);
      crop.dpr = dpr;
    }

    // Capture full visible tab
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality });
    const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');

    // Crop if needed
    let finalBase64 = base64;
    if (crop) {
      finalBase64 = await cropViaOffscreen(base64, crop);
    }

    return {
      content: [
        { type: 'image', data: finalBase64, mimeType: 'image/jpeg' },
      ],
      details: { status: 'done' },
    };
  },
};
```

- [ ] **Step 4.3: Update system prompt for screenshot capabilities**

In `lib/constants.ts`, update the screenshot bullet:

```
- **screenshot**: Capture the visible area of the active tab. Optionally provide a CSS selector to capture only that element, or a clip region {x, y, width, height} for a specific viewport area.
```

- [ ] **Step 4.4: Commit**

```bash
git add lib/tools/screenshot.ts entrypoints/offscreen/main.ts lib/constants.ts
git commit -m "feat: add region screenshot support via selector and clip"
```

---

### Task 5: Confirm scroll already supports CSS selector + update system prompt

**Files:**
- Modify: `lib/constants.ts` (clarify scroll supports selector in system prompt)

The `scroll` action in `interact.ts` already supports the `selector` parameter — when provided it calls `getEl()` which resolves the selector and scrolls that specific element. The current system prompt's scroll description just says "scroll — scroll the page or an element" which is vague.

- [ ] **Step 5.1: Update system prompt scroll description**

In `lib/constants.ts`, update the scroll line in the interact section:

```
  - scroll — scroll the page or a specific element (provide CSS selector to scroll within a container). Use deltaX/deltaY to control direction and distance.
```

- [ ] **Step 5.2: Commit**

```bash
git add lib/constants.ts
git commit -m "docs: clarify scroll supports CSS selector in system prompt"
```

---

## Summary of all changes

| Task | Files changed | Description |
|------|--------------|-------------|
| 1 | `execute-js.ts`, `constants.ts` | Clarify "async function body + return" semantics |
| 2 | `page-context.ts`, `tab.ts`, `constants.ts` | Window ID in context + tab open windowId param |
| 3 | `interact.ts`, `constants.ts` | Add `sequence` action for batch multi-step interactions |
| 4 | `screenshot.ts`, `offscreen/main.ts`, `constants.ts` | Region screenshot via selector or clip |
| 5 | `constants.ts` | Clarify scroll supports CSS selector |

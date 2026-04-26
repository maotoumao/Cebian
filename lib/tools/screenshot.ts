import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_SCREENSHOT } from '@/lib/types';
import { getActiveTabId, executeInTabWithArgs } from '@/lib/tab-helpers';
import { ensureOffscreen } from './offscreen';
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
  tabId: Type.Number({
    description:
      'Required. Tab ID to capture. Read it from the `tabId:` line under `[Active Tab]` (or the windows list) in the context block. ' +
      'If the tab is not visible, it will be temporarily activated for the screenshot. ' +
      'Never omit — the active tab may have changed since the last context snapshot.',
  }),
});

/** Get viewport size + DPR for the active tab (used both for coord metadata and clip scaling). */
async function getViewportInfo(): Promise<{ width: number; height: number; dpr: number }> {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio ?? 1,
  };
}

/** Get the bounding rect for a selector in the page. Waits one frame after scrollIntoView. */
async function getElementRect(selector: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return null;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  await new Promise(r => requestAnimationFrame(r));
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/** Crop an image via the offscreen document's Canvas API. */
async function cropViaOffscreen(
  base64: string,
  crop: { x: number; y: number; width: number; height: number; dpr: number },
): Promise<string> {
  await ensureOffscreen();
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
    'Capture a browser tab as an image for VISUAL analysis. ' +
    'USE FOR questions about rendered pixels: canvas/WebGL (maps, charts, games), video frames, embedded PDFs, SVG-as-paths, font/layout/z-index/overflow rendering bugs, CAPTCHAs to relay to the user, or when the user explicitly asks to see the page. ' +
    'DO NOT USE to find clickable elements, to verify that an action succeeded, or to survey the page before acting — those are DOM questions, use `inspect` (+ `read_page` for text) instead. A screenshot cannot produce a selector; if you plan to act afterwards you will still need `inspect`. ' +
    'Modes: full visible area (default), a specific element (pass `selector` — scrolled into view and cropped), or a viewport sub-area (pass `clip`). Composable: use `inspect` first to locate the element, then pass its selector here for the visual payload. ' +
    'The response includes a text block with the viewport size, device pixel ratio, and image dimensions — READ IT before passing any pixel coordinate from this image to `interact`. Image pixels = CSS pixels × DPR; `interact` expects CSS pixels, so divide by DPR (and add the crop origin when present).',
  parameters: ScreenshotParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    const quality = params.quality ?? 80;
    const tabId = params.tabId;

    // If the target tab is not active, temporarily switch for captureVisibleTab
    let previousTabId: number | undefined;
    const activeTabId = await getActiveTabId();
    if (tabId !== activeTabId) {
      previousTabId = activeTabId;
      await chrome.tabs.update(tabId, { active: true });
      // Wait for the tab to render
      await new Promise(r => setTimeout(r, 300));
    }

    try {
      // Always fetch viewport info: it's returned to the agent as metadata so the
      // agent can translate screenshot pixels (= CSS × dpr) back to CSS-pixel
      // coordinates before passing them to `interact`. Also reused as the DPR
      // source for the `clip` path instead of a separate round-trip.
      const viewport = await executeInTabWithArgs(tabId, getViewportInfo, []);

      // Determine crop region
      let crop: { x: number; y: number; width: number; height: number; dpr: number } | null = null;

      if (params.selector) {
        const rect = await executeInTabWithArgs(tabId, getElementRect, [params.selector]);
        if (!rect) {
          return {
            content: [{ type: 'text', text: `Error: element not found: ${params.selector}` }],
            details: { status: 'error' },
          };
        }
        // Stamp crop with the viewport's DPR — single source of truth, avoids
        // inconsistency if display scaling changes between the two in-page calls.
        crop = { ...rect, dpr: viewport.dpr };
      } else if (params.clip) {
        crop = { ...params.clip, dpr: viewport.dpr };
      }

      // Validate crop dimensions
      if (crop && (crop.width <= 0 || crop.height <= 0)) {
        return {
          content: [{ type: 'text', text: 'Error: crop region has zero or negative dimensions.' }],
          details: { status: 'error' },
        };
      }

      // Capture full visible tab
      const dataUrl = await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality });
      const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');

      // Crop if needed
      let finalBase64 = base64;
      if (crop) {
        finalBase64 = await cropViaOffscreen(base64, crop);
      }

      // Build a coordinate-space hint the model can reason about.
      // Image pixels = CSS pixels × dpr, so any (x, y) the model reads off the
      // image must be divided by dpr before being passed to `interact`. Element /
      // clip crops also shift the origin — the image (0,0) corresponds to the
      // element's top-left in the viewport, not the viewport's own (0,0).
      const imgW = crop
        ? Math.round(crop.width * crop.dpr)
        : Math.round(viewport.width * viewport.dpr);
      const imgH = crop
        ? Math.round(crop.height * crop.dpr)
        : Math.round(viewport.height * viewport.dpr);
      // Format DPR to avoid ugly floats like 1.7999999523162842 on some Windows
      // scaling settings — Chrome canonically reports 1, 1.25, 1.5, 2, 3 etc.
      const dprStr = Number(viewport.dpr.toFixed(4)).toString();
      const parts: string[] = [
        `Viewport: ${viewport.width}×${viewport.height} CSS px`,
        `DPR: ${dprStr}`,
        `Image: ${imgW}×${imgH} px`,
      ];
      if (viewport.dpr !== 1) {
        parts.push(`To target \`interact\` from image pixel (px, py): x = px/${dprStr}, y = py/${dprStr}`);
      } else {
        parts.push('Image pixels == CSS pixels (dpr=1), no conversion needed');
      }
      if (crop) {
        parts.push(`Crop origin: CSS viewport (${crop.x}, ${crop.y}) — add this offset to the converted coords`);
      }
      const meta = parts.join(' · ');

      return {
        content: [
          { type: 'text', text: meta },
          { type: 'image', data: finalBase64, mimeType: 'image/jpeg' },
        ],
        details: { status: 'done' },
      };
    } finally {
      // Restore the previous tab if we swapped
      if (previousTabId != null) {
        try { await chrome.tabs.update(previousTabId, { active: true }); } catch { /* tab may have been closed */ }
      }
    }
  },
};

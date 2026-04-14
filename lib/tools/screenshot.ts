import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_SCREENSHOT } from '@/lib/types';
import { getActiveTabId, executeInTabWithArgs } from './chrome-api';
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
});

/** Get the bounding rect and DPR for a selector in the page. Waits one frame after scrollIntoView. */
async function getElementRect(selector: string): Promise<{ x: number; y: number; width: number; height: number; dpr: number } | null> {
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
    dpr: window.devicePixelRatio ?? 1,
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
    'Capture a screenshot of the active tab. ' +
    'By default captures the full visible area. ' +
    'To capture a specific element, provide its CSS selector — the element is scrolled into view and cropped automatically. ' +
    'To capture a viewport sub-area, provide a clip region {x, y, width, height}. ' +
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
      const tabId = await getActiveTabId();
      const dpr = await executeInTabWithArgs(tabId, () => window.devicePixelRatio ?? 1, []);
      crop = { ...params.clip, dpr };
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

    return {
      content: [
        { type: 'image', data: finalBase64, mimeType: 'image/jpeg' },
      ],
      details: { status: 'done' },
    };
  },
};

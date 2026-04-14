// Offscreen document: provides DOM APIs (DOMParser, document) for
// HTML→markdown conversion that can't run in the background service worker.

import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

// ─── Message types ───

export type OffscreenRequest =
  | { type: 'html-to-markdown'; html: string; readability?: { url: string } }
  | { type: 'crop-image'; imageData: string; crop: { x: number; y: number; width: number; height: number } };

export interface OffscreenResponse {
  result?: string;
  error?: string;
}

// ─── Processing functions ───

function parseWithReadability(html: string, url: string): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const base = doc.createElement('base');
  base.href = url;
  doc.head.prepend(base);
  const article = new Readability(doc).parse();
  return article?.content ?? null;
}

function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  turndown.use(gfm);
  turndown.remove(['style', 'script', 'noscript']);
  return turndown.turndown(html);
}

// ─── Image cropping ───

async function cropImage(
  base64: string,
  crop: { x: number; y: number; width: number; height: number },
): Promise<string> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('Failed to load image for cropping'));
    img.src = `data:image/jpeg;base64,${base64}`;
  });

  const clampedX = Math.max(0, Math.min(crop.x, img.width));
  const clampedY = Math.max(0, Math.min(crop.y, img.height));
  const clampedW = Math.min(crop.width, img.width - clampedX);
  const clampedH = Math.min(crop.height, img.height - clampedY);

  if (clampedW <= 0 || clampedH <= 0) {
    throw new Error('Crop region is outside image bounds or has zero dimensions');
  }

  const canvas = document.createElement('canvas');
  canvas.width = clampedW;
  canvas.height = clampedH;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, clampedX, clampedY, clampedW, clampedH, 0, 0, clampedW, clampedH);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  return dataUrl.replace(/^data:image\/jpeg;base64,/, '');
}

// ─── Message listener ───

chrome.runtime.onMessage.addListener(
  (message: OffscreenRequest, _sender, sendResponse) => {
    if (message.type === 'crop-image') {
      cropImage(message.imageData, message.crop)
        .then(result => sendResponse({ result } satisfies OffscreenResponse))
        .catch(err => sendResponse({ error: (err as Error).message } satisfies OffscreenResponse));
      return true;
    }

    if (message.type !== 'html-to-markdown') return;

    try {
      let html = message.html;

      // Optionally run Readability first
      if (message.readability) {
        const articleHtml = parseWithReadability(html, message.readability.url);
        if (!articleHtml) {
          sendResponse({ error: 'readability-failed' } satisfies OffscreenResponse);
          return true;
        }
        html = articleHtml;
      }

      const markdown = htmlToMarkdown(html);
      sendResponse({ result: markdown } satisfies OffscreenResponse);
    } catch (err: any) {
      sendResponse({ error: err.message ?? String(err) } satisfies OffscreenResponse);
    }

    return true; // keep sendResponse channel open
  },
);

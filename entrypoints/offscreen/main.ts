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
  (message: OffscreenRequest | SandboxRelayMessage, _sender, sendResponse) => {
    // ─── Sandbox relay: forward messages to/from sandbox iframe ───
    if ('type' in message && typeof message.type === 'string' && message.type.startsWith('sandbox:')) {
      const sandboxMsg = message as SandboxRelayMessage;

      // Messages TO sandbox (run, chrome_result, page_exec_result)
      if (sandboxMsg.type === 'sandbox:run' ||
          sandboxMsg.type === 'sandbox:chrome_result' ||
          sandboxMsg.type === 'sandbox:page_exec_result') {
        ensureSandboxFrame();
        if (sandboxReady) {
          sandboxFrame!.contentWindow?.postMessage(sandboxMsg, '*');
        } else {
          pendingSandboxMessages.push(sandboxMsg);
        }
        sendResponse({ ok: true });
        return false;
      }

      return false;
    }

    // ─── Original offscreen handlers ───
    const req = message as OffscreenRequest;
    if (req.type === 'crop-image') {
      cropImage(req.imageData, req.crop)
        .then(result => sendResponse({ result } satisfies OffscreenResponse))
        .catch(err => sendResponse({ error: (err as Error).message } satisfies OffscreenResponse));
      return true;
    }

    if (req.type !== 'html-to-markdown') return;

    try {
      let html = req.html;

      // Optionally run Readability first
      if (req.readability) {
        const articleHtml = parseWithReadability(html, req.readability.url);
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

// ─── Sandbox iframe host ───
// The sandbox page cannot be embedded directly by the background SW.
// Offscreen document acts as host: embeds sandbox iframe and relays
// messages between background (chrome.runtime.onMessage) and sandbox (postMessage).

type SandboxRelayMessage = { type: string; [key: string]: unknown };

let sandboxFrame: HTMLIFrameElement | null = null;
let sandboxReady = false;
const pendingSandboxMessages: SandboxRelayMessage[] = [];

function ensureSandboxFrame(): void {
  if (sandboxFrame) return;
  sandboxFrame = document.createElement('iframe');
  sandboxFrame.src = chrome.runtime.getURL('/sandbox.html');
  sandboxFrame.style.display = 'none';
  document.body.appendChild(sandboxFrame);
}

// Relay messages from sandbox iframe → background
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'sandbox:ready') {
    sandboxReady = true;
    // Flush any messages that arrived before sandbox was ready
    for (const queued of pendingSandboxMessages) {
      sandboxFrame?.contentWindow?.postMessage(queued, '*');
    }
    pendingSandboxMessages.length = 0;
    return;
  }

  // Forward sandbox responses to background (chrome_call, page_exec, run_result)
  if (msg.type.startsWith('sandbox:')) {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
});

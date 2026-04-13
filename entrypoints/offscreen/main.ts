// Offscreen document: provides DOM APIs (DOMParser, document) for
// HTML→markdown conversion that can't run in the background service worker.

import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

// ─── Message types ───

export interface OffscreenRequest {
  type: 'html-to-markdown';
  html: string;
  /** If provided, run Readability before markdown conversion. */
  readability?: { url: string };
}

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

// ─── Message listener ───

chrome.runtime.onMessage.addListener(
  (message: OffscreenRequest, _sender, sendResponse) => {
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

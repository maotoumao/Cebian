import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_READ_PAGE } from '@/lib/types';
import { getActiveTabId, executeInTabWithArgs } from './chrome-api';
import type { OffscreenRequest, OffscreenResponse } from '@/entrypoints/offscreen/main';

const ReadPageParameters = Type.Object({
  mode: Type.Union(
    [
      Type.Literal('text'),
      Type.Literal('html'),
      Type.Literal('markdown'),
      Type.Literal('article'),
      Type.Literal('readable'),
    ],
    {
      description:
        'Extraction mode. ' +
        '"markdown" (default): full-page content as markdown — works for any page type. ' +
        '"article": article/reader-mode extraction as markdown — use for news, blogs, docs. ' +
        '"text": plain innerText. ' +
        '"html": cleaned innerHTML (no script/style/svg). ' +
        '"readable": deprecated alias for "article".',
      default: 'markdown',
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

// ─── In-page functions (self-contained, no closures) ───

/** Extract plain innerText from the page. */
function extractText(selector: string | null): string {
  const root = selector
    ? document.querySelector(selector) as HTMLElement | null
    : document.body;
  if (!root) return selector
    ? `(no element found for selector: ${selector})`
    : '(page has no body element)';
  return root.innerText;
}

/** Extract cleaned innerHTML (no script/style/svg). */
function extractHtml(selector: string | null): string {
  const root = selector
    ? document.querySelector(selector) as HTMLElement | null
    : document.body;
  if (!root) return selector
    ? `(no element found for selector: ${selector})`
    : '(page has no body element)';
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script, style, svg, noscript').forEach(el => el.remove());
  return clone.innerHTML;
}

/** Extract cleaned HTML with extra noise removal (hidden elements, stylesheets). */
function extractCleanHtml(selector: string | null): string {
  const root = selector
    ? document.querySelector(selector) as HTMLElement | null
    : document.body;
  if (!root) return selector
    ? `(no element found for selector: ${selector})`
    : '(page has no body element)';
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script, style, svg, noscript, link[rel="stylesheet"]').forEach(el => el.remove());
  clone.querySelectorAll('[aria-hidden="true"], [hidden]').forEach(el => el.remove());
  // Strip inline style attributes — they add noise without semantic value
  clone.querySelectorAll('[style]').forEach(el => el.removeAttribute('style'));
  return clone.innerHTML;
}

/** Get the full document HTML for Readability processing. */
function getDocumentHtml(selector: string | null): { html: string; url: string } {
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) return { html: '', url: window.location.href };
    return { html: el.outerHTML, url: window.location.href };
  }
  return { html: document.documentElement.outerHTML, url: window.location.href };
}

// ─── Offscreen document helpers ───

const OFFSCREEN_URL = 'offscreen.html';

/** Singleton promise to avoid concurrent createDocument calls. */
let offscreenReady: Promise<void> | null = null;

/** Ensure the offscreen document exists, creating it if needed. */
async function ensureOffscreen(): Promise<void> {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const existing = await chrome.offscreen.hasDocument();
      if (existing) return;
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL(OFFSCREEN_URL),
        reasons: ['DOM_PARSER'],
        justification: 'Parse HTML to markdown using DOMParser + Readability + Turndown',
      });
    })();
  }
  return offscreenReady;
}

/** Send HTML to the offscreen document for markdown conversion. */
async function convertHtmlToMarkdown(html: string): Promise<string> {
  await ensureOffscreen();
  const msg: OffscreenRequest = { type: 'html-to-markdown', html };
  const resp: OffscreenResponse = await chrome.runtime.sendMessage(msg);
  if (resp.error) throw new Error(`Offscreen conversion failed: ${resp.error}`);
  return resp.result ?? '';
}

/** Send HTML to the offscreen document for Readability + markdown conversion. */
async function convertArticleToMarkdown(html: string, url: string): Promise<string | null> {
  await ensureOffscreen();
  const msg: OffscreenRequest = { type: 'html-to-markdown', html, readability: { url } };
  const resp: OffscreenResponse = await chrome.runtime.sendMessage(msg);
  if (resp.error === 'readability-failed') return null;
  if (resp.error) throw new Error(`Offscreen conversion failed: ${resp.error}`);
  return resp.result ?? '';
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + `\n\n...(truncated at ${maxLength} chars)`;
}

// ─── Tool definition ───

export const readPageTool: AgentTool<typeof ReadPageParameters> = {
  name: TOOL_READ_PAGE,
  label: 'Read Page',
  description:
    'Extract content from the current page. ' +
    'Modes: "markdown" (default, full-page as markdown — works for any page), ' +
    '"article" (reader-mode extraction as markdown — for news/blogs/docs), ' +
    '"text" (plain text), "html" (cleaned HTML). ' +
    'Optionally scope to a CSS selector. ' +
    'Use this before answering questions about page content.',
  parameters: ReadPageParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    const tabId = await getActiveTabId();
    const mode = params.mode ?? 'markdown';
    const maxLength = params.maxLength ?? 20000;

    let content: string;

    switch (mode) {
      case 'text': {
        content = await executeInTabWithArgs(tabId, extractText, [params.selector ?? null], params.frameId);
        break;
      }
      case 'html': {
        content = await executeInTabWithArgs(tabId, extractHtml, [params.selector ?? null], params.frameId);
        break;
      }
      case 'markdown': {
        // Full-page cleaned HTML → markdown via offscreen document
        const html = await executeInTabWithArgs(tabId, extractCleanHtml, [params.selector ?? null], params.frameId);
        content = await convertHtmlToMarkdown(html);
        break;
      }
      case 'article':
      case 'readable': {
        // Readability extraction → markdown ("readable" is a deprecated alias)
        if (params.selector) {
          const html = await executeInTabWithArgs(tabId, extractCleanHtml, [params.selector], params.frameId);
          content = await convertHtmlToMarkdown(html);
          break;
        }

        const { html, url } = await executeInTabWithArgs(tabId, getDocumentHtml, [null], params.frameId);
        const articleMd = await convertArticleToMarkdown(html, url);
        if (!articleMd) {
          const fallback = await executeInTabWithArgs(tabId, extractText, [null], params.frameId);
          content = '(Readability extraction failed, falling back to plain text)\n\n' + fallback;
          break;
        }
        content = articleMd;
        break;
      }
      default:
        content = await executeInTabWithArgs(tabId, extractText, [params.selector ?? null], params.frameId);
    }

    return {
      content: [{ type: 'text', text: truncate(content, maxLength) }],
      details: { status: 'done' },
    };
  },
};

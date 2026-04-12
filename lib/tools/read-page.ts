import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { TOOL_READ_PAGE } from '@/lib/types';
import { getActiveTabId, executeInTabWithArgs } from './chrome-api';

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

// ─── Extension-side processing ───

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + `\n\n...(truncated at ${maxLength} chars)`;
}

function parseWithReadability(html: string, url: string): string | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Set base URL for relative link resolution
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
  return turndown.turndown(html);
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
        // Full-page cleaned HTML → markdown (no Readability filtering)
        const html = await executeInTabWithArgs(tabId, extractCleanHtml, [params.selector ?? null], params.frameId);
        content = htmlToMarkdown(html);
        break;
      }
      case 'article':
      case 'readable': {
        // Readability extraction → markdown ("readable" is a deprecated alias)
        if (params.selector) {
          const html = await executeInTabWithArgs(tabId, extractCleanHtml, [params.selector], params.frameId);
          content = htmlToMarkdown(html);
          break;
        }

        const { html, url } = await executeInTabWithArgs(tabId, getDocumentHtml, [null], params.frameId);
        const articleHtml = parseWithReadability(html, url);
        if (!articleHtml) {
          const fallback = await executeInTabWithArgs(tabId, extractText, [null], params.frameId);
          content = '(Readability extraction failed, falling back to plain text)\n\n' + fallback;
          break;
        }
        content = htmlToMarkdown(articleHtml);
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

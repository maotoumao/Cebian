import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { TOOL_READ_PAGE } from '@/lib/types';
import { getActiveTabId, executeInTabWithArgs } from './chrome-api';

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
        '"markdown": readable content converted to markdown — best for analysis.',
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

// ─── In-page functions (self-contained, no closures) ───

/** Extract plain innerText from the page. */
function extractText(selector: string | undefined): string {
  const root = selector
    ? document.querySelector(selector) as HTMLElement | null
    : document.body;
  if (!root) return selector
    ? `(no element found for selector: ${selector})`
    : '(page has no body element)';
  return root.innerText;
}

/** Extract cleaned innerHTML (no script/style/svg). */
function extractHtml(selector: string | undefined): string {
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

/** Get the full document HTML for Readability processing. */
function getDocumentHtml(selector: string | undefined): { html: string; url: string } {
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
  return turndown.turndown(html);
}

// ─── Tool definition ───

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

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    const tabId = await getActiveTabId();
    const mode = params.mode ?? 'readable';
    const maxLength = params.maxLength ?? 20000;

    let content: string;

    switch (mode) {
      case 'text': {
        content = await executeInTabWithArgs(tabId, extractText, [params.selector], params.frameId);
        break;
      }
      case 'html': {
        content = await executeInTabWithArgs(tabId, extractHtml, [params.selector], params.frameId);
        break;
      }
      case 'readable':
      case 'markdown': {
        // If selector is provided, skip Readability (it needs full document)
        // and go directly HTML → Turndown for markdown, or HTML as readable.
        if (params.selector) {
          const html = await executeInTabWithArgs(
            tabId, extractHtml, [params.selector], params.frameId,
          );
          content = mode === 'markdown' ? htmlToMarkdown(html) : html;
          break;
        }

        // Step 1: Get full document HTML from page
        const { html, url } = await executeInTabWithArgs(
          tabId, getDocumentHtml, [undefined], params.frameId,
        );

        // Step 2: Extract article with Readability (extension context)
        const articleHtml = parseWithReadability(html, url);
        if (!articleHtml) {
          // Readability couldn't parse — fall back to cleaned text
          const fallback = await executeInTabWithArgs(tabId, extractText, [params.selector], params.frameId);
          content = '(Readability extraction failed, falling back to plain text)\n\n' + fallback;
          break;
        }

        // Step 3: Convert to markdown if requested
        content = mode === 'markdown' ? htmlToMarkdown(articleHtml) : articleHtml;
        break;
      }
      default:
        content = await executeInTabWithArgs(tabId, extractText, [params.selector], params.frameId);
    }

    return {
      content: [{ type: 'text', text: truncate(content, maxLength) }],
      details: { status: 'done' },
    };
  },
};

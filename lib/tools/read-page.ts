import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
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
 * Must be self-contained — no closures over outer scope.
 */
function extractPageContent(
  mode: string, selector: string | undefined, maxLength: number,
): string {
  const root = selector
    ? document.querySelector(selector) as HTMLElement | null
    : document.body;
  if (!root) return selector
    ? `(no element found for selector: ${selector})`
    : '(page has no body element)';

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
      const clone = root.cloneNode(true) as HTMLElement;
      // Remove noise elements
      clone.querySelectorAll(
        'script, style, svg, noscript, iframe, nav, header, footer, aside, ' +
        '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
        '.sidebar, .nav, .menu, .footer, .header, .ad, .advertisement, .social-share',
      ).forEach(el => el.remove());

      if (mode === 'markdown') {
        const BLOCK_TAGS = new Set([
          'p', 'div', 'section', 'article', 'main',
          'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'ul', 'ol', 'li', 'blockquote', 'pre', 'table',
          'hr', 'br', 'figure', 'figcaption', 'details', 'summary',
        ]);
        const lines: string[] = [];
        let inlineBuffer = '';

        const flushInline = () => {
          const trimmed = inlineBuffer.trim();
          if (trimmed) lines.push(trimmed);
          inlineBuffer = '';
        };

        const walk = (node: Node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent ?? '';
            if (text.trim()) inlineBuffer += text.replace(/\s+/g, ' ');
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const el = node as HTMLElement;
          const tag = el.tagName.toLowerCase();

          if (tag === 'br') { flushInline(); lines.push(''); return; }
          if (tag === 'hr') { flushInline(); lines.push('---'); return; }

          if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
            flushInline();
            const level = parseInt(tag[1]);
            lines.push('');
            lines.push('#'.repeat(level) + ' ' + el.innerText.trim());
            lines.push('');
            return;
          }
          if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') {
            flushInline();
            lines.push('');
            el.childNodes.forEach(walk);
            flushInline();
            lines.push('');
            return;
          }
          if (tag === 'li') {
            flushInline();
            lines.push('- ' + el.innerText.trim());
            return;
          }
          if (tag === 'pre') {
            flushInline();
            lines.push('```');
            lines.push(el.innerText);
            lines.push('```');
            return;
          }
          // Inline elements — append to buffer
          if (tag === 'a') {
            const href = el.getAttribute('href') ?? '';
            inlineBuffer += `[${el.innerText.trim()}](${href})`;
            return;
          }
          if (tag === 'code') {
            inlineBuffer += '`' + el.innerText + '`';
            return;
          }
          if (tag === 'strong' || tag === 'b') {
            inlineBuffer += '**' + el.innerText.trim() + '**';
            return;
          }
          if (tag === 'em' || tag === 'i') {
            inlineBuffer += '*' + el.innerText.trim() + '*';
            return;
          }
          if (tag === 'img') {
            const alt = el.getAttribute('alt') ?? '';
            const src = el.getAttribute('src') ?? '';
            if (alt || src) { flushInline(); lines.push(`![${alt}](${src})`); }
            return;
          }
          if (tag === 'blockquote') {
            flushInline();
            el.innerText.split('\n').forEach(l => lines.push('> ' + l));
            return;
          }
          // Table: first row assumed to be header
          if (tag === 'table') {
            flushInline();
            const rows = el.querySelectorAll('tr');
            rows.forEach((row, i) => {
              const cells = Array.from(row.querySelectorAll('th, td'))
                .map(c => (c as HTMLElement).innerText.trim());
              lines.push('| ' + cells.join(' | ') + ' |');
              if (i === 0) lines.push('| ' + cells.map(() => '---').join(' | ') + ' |');
            });
            return;
          }

          // Unknown element — recurse if block, append if inline
          if (BLOCK_TAGS.has(tag)) {
            flushInline();
            el.childNodes.forEach(walk);
            flushInline();
          } else {
            el.childNodes.forEach(walk);
          }
        };
        walk(clone);
        flushInline();
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

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
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

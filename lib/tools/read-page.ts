import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_READ_PAGE } from '@/lib/types';
import { getActiveTabId, executeInTabWithArgs } from './chrome-api';
import { ensureOffscreen } from './offscreen';
import type { OffscreenRequest, OffscreenResponse } from '@/entrypoints/offscreen/main';

const ReadPageParameters = Type.Object({
  mode: Type.Union(
    [
      Type.Literal('text'),
      Type.Literal('html'),
      Type.Literal('markdown'),
      Type.Literal('article'),
      Type.Literal('outline'),
    ],
    {
      description:
        'Extraction mode. ' +
        '"markdown" (default): full-page content as markdown — works for any page type. ' +
        '"article": article/reader-mode extraction as markdown — use for news, blogs, docs. ' +
        '"outline": page structure overview — shows visual regions with selectors, positions, interactive element counts, and text previews. Lower token cost than markdown/html. Use to understand page layout before acting. ' +
        '"text": plain innerText. ' +
        '"html": cleaned innerHTML (no script/style/svg).',
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

/** Extract a structural outline of the page's visual regions. */
function extractOutline(selector: string | null): string {
  const MIN_WIDTH = 50;
  const MIN_HEIGHT = 30;
  const MAX_DEPTH = 4;
  const MAX_NODES = 200;
  const TEXT_LEN = 60;
  const INLINE_TAGS = new Set(['SPAN', 'A', 'EM', 'STRONG', 'B', 'I', 'U', 'S', 'SMALL', 'SUB', 'SUP', 'BR', 'WBR', 'ABBR', 'CODE', 'KBD', 'MARK', 'Q', 'CITE', 'TIME', 'LABEL']);
  const SEMANTIC_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'ASIDE', 'MAIN', 'SECTION', 'ARTICLE', 'FORM']);

  let nodeCount = 0;

  const root = selector
    ? document.querySelector(selector) as HTMLElement | null
    : document.body;
  if (!root) return selector
    ? `(no element found for selector: ${selector})`
    : '(page has no body element)';

  function getSelector(el: HTMLElement): string {
    if (el.id) return '#' + CSS.escape(el.id);
    const path: string[] = [];
    let node: HTMLElement | null = el;
    while (node && node !== document.body) {
      let seg = node.tagName.toLowerCase();
      if (node.id) {
        path.unshift('#' + CSS.escape(node.id));
        break;
      }
      const siblings = node.parentElement
        ? Array.from(node.parentElement.children).filter(c => c.tagName === node!.tagName)
        : [];
      if (siblings.length > 1) {
        seg += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      path.unshift(seg);
      node = node.parentElement;
    }
    return path.join(' > ');
  }

  function countInteractive(el: HTMLElement) {
    return {
      inputs: el.querySelectorAll('input, textarea, select, [contenteditable="true"]').length,
      buttons: el.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').length,
      links: el.querySelectorAll('a[href]').length,
      images: el.querySelectorAll('img, svg, [role="img"]').length,
    };
  }

  function getTextPreview(el: HTMLElement): string {
    let text = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += (child.textContent ?? '').trim() + ' ';
      }
    }
    text = text.trim();
    if (!text) {
      text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    }
    return text.length > TEXT_LEN ? text.slice(0, TEXT_LEN) + '...' : text;
  }

  function getClues(el: HTMLElement): string[] {
    const clues: string[] = [];
    if (el.id) clues.push('id=' + el.id);
    if (el.className && typeof el.className === 'string') {
      clues.push('class=' + el.className.split(/\s+/).slice(0, 3).join(' '));
    }
    const role = el.getAttribute('role');
    if (role) clues.push('role=' + role);
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) clues.push('aria=' + ariaLabel);
    if (el.shadowRoot) clues.push('shadow-root');
    return clues;
  }

  /** Check if element is a meaningful visual block. Returns its rect if yes, null if not. */
  function getVisualRect(el: HTMLElement): DOMRect | null {
    if (el.offsetParent === null && el.getClientRects().length === 0) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) return null;
    // Count block-level children using tag-based heuristic (avoids getComputedStyle)
    const blockChildren = Array.from(el.children).filter(c => !INLINE_TAGS.has(c.tagName));
    if (blockChildren.length === 0 && !el.querySelector('input, button, a, select, textarea, img')) {
      // Allow if element has meaningful direct text
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => (n.textContent ?? '').trim())
        .join('');
      if (directText.length < 20) return null;
    }
    return rect;
  }

  interface OutlineNode {
    tag: string;
    sel: string;
    rect: { x: number; y: number; w: number; h: number };
    text: string;
    inter: { inputs: number; buttons: number; links: number; images: number };
    clues: string[];
    style: { position: string; zIndex: string; overflow: string };
    children: OutlineNode[];
  }

  function traverse(el: HTMLElement, depth: number): OutlineNode[] {
    if (depth > MAX_DEPTH || nodeCount >= MAX_NODES) return [];
    const results: OutlineNode[] = [];

    for (const child of el.children) {
      if (nodeCount >= MAX_NODES) break;
      if (!(child instanceof HTMLElement)) continue;

      const rect = getVisualRect(child);
      if (!rect) continue;

      const inter = countInteractive(child);
      const hasContent = inter.inputs + inter.buttons + inter.links + inter.images > 0
        || (child.textContent?.trim().length ?? 0) > 0;
      if (!hasContent) continue;

      nodeCount++;

      const cs = getComputedStyle(child);
      const style = {
        position: cs.position === 'static' ? '' : cs.position,
        zIndex: cs.zIndex === 'auto' ? '' : cs.zIndex,
        overflow: (cs.overflow === 'visible' || cs.overflow === '') ? '' : cs.overflow,
      };

      const node: OutlineNode = {
        tag: child.tagName.toLowerCase(),
        sel: getSelector(child),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        text: getTextPreview(child),
        inter,
        clues: getClues(child),
        style,
        children: traverse(child, depth + 1),
      };

      // Flatten: skip pure wrappers — but keep semantic tags, elements with notable styles, or elements with links
      const hasNotableStyle = style.position || style.zIndex || style.overflow;
      const isSemantic = SEMANTIC_TAGS.has(child.tagName);
      if (node.children.length === 1 && !node.text && !hasNotableStyle && !isSemantic
        && node.inter.inputs === 0 && node.inter.buttons === 0 && node.inter.links === 0) {
        results.push(...node.children);
      } else {
        results.push(node);
      }
    }
    return results;
  }

  function formatNode(node: OutlineNode, indent: number): string[] {
    const pad = '  '.repeat(indent);

    const interParts: string[] = [];
    if (node.inter.inputs) interParts.push(node.inter.inputs + ' input');
    if (node.inter.buttons) interParts.push(node.inter.buttons + ' btn');
    if (node.inter.links) interParts.push(node.inter.links + ' link');
    if (node.inter.images) interParts.push(node.inter.images + ' img');
    const interStr = interParts.length ? ' | ' + interParts.join(', ') : '';

    const clueStr = node.clues.length ? ' {' + node.clues.join('; ') + '}' : '';
    const textStr = node.text ? ' "' + node.text + '"' : '';

    const styleParts: string[] = [];
    if (node.style.position) styleParts.push(node.style.position);
    if (node.style.zIndex) styleParts.push('z=' + node.style.zIndex);
    if (node.style.overflow) styleParts.push('overflow=' + node.style.overflow);
    const styleStr = styleParts.length ? ' [' + styleParts.join(', ') + ']' : '';

    const line = `${pad}${node.sel} <${node.tag}> [${node.rect.x},${node.rect.y} ${node.rect.w}×${node.rect.h}]${styleStr}${interStr}${clueStr}${textStr}`;

    const lines = [line];
    for (const child of node.children) {
      lines.push(...formatNode(child, indent + 1));
    }
    return lines;
  }

  const tree = traverse(root, 0);
  const totalInter = countInteractive(root);

  const header: string[] = [];
  if (selector) {
    const rootRect = root.getBoundingClientRect();
    header.push(`Outline of ${selector} <${root.tagName.toLowerCase()}> [${Math.round(rootRect.x)},${Math.round(rootRect.y)} ${Math.round(rootRect.width)}×${Math.round(rootRect.height)}]:`);
  } else {
    header.push(`Page outline (${tree.length} top regions):`);
  }

  const footer = [`[Total] ${totalInter.inputs} inputs, ${totalInter.buttons} buttons, ${totalInter.links} links, ${totalInter.images} images`];
  if (nodeCount >= MAX_NODES) {
    footer.push(`(outline truncated at ${MAX_NODES} nodes — use selector to drill into a specific region)`);
  }

  return [
    ...header,
    '',
    ...tree.flatMap(n => formatNode(n, 0)),
    '',
    ...footer,
  ].join('\n');
}

// ─── Offscreen document helpers ───

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
    '"outline" (page structure overview — visual regions with selectors, positions, interactive elements; use to understand layout before acting), ' +
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
      case 'outline': {
        content = await executeInTabWithArgs(tabId, extractOutline, [params.selector ?? null], params.frameId);
        break;
      }
      case 'article': {
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

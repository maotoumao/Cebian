import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_READ_PAGE } from '@/lib/types';
import { resolveTabId, executeInTabWithArgs } from './chrome-api';
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
  tabId: Type.Optional(
    Type.Number({
      description:
        'Tab ID to read from. Omit to use the active tab. ' +
        'Get tab IDs from the context block.',
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
  const MAX_DEPTH = 6;
  const MAX_NODES = 200;
  const MAX_RAW_DEPTH = 30;
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

  /** Count interactive elements that are DIRECT children of el (not descendants). */
  function countDirectInteractive(el: HTMLElement) {
    const result = { inputs: 0, buttons: 0, links: 0, images: 0 };
    for (const child of el.children) {
      if (!(child instanceof HTMLElement)) continue;
      const tag = child.tagName;
      const type = child.getAttribute('type');
      if (tag === 'BUTTON' || child.getAttribute('role') === 'button'
        || (tag === 'INPUT' && (type === 'submit' || type === 'button'))) {
        result.buttons++;
      } else if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
        || child.getAttribute('contenteditable') === 'true') {
        result.inputs++;
      }
      if (tag === 'A' && child.hasAttribute('href')) result.links++;
      if (tag === 'IMG' || tag === 'SVG' || child.getAttribute('role') === 'img') result.images++;
    }
    return result;
  }

  /** Count ALL interactive descendants (used for the final summary line only). */
  function countAllInteractive(el: HTMLElement) {
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

  function getVisualRect(el: HTMLElement): DOMRect | null {
    if (el.offsetParent === null && el.getClientRects().length === 0) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) return null;
    const blockChildren = Array.from(el.children).filter(c => !INLINE_TAGS.has(c.tagName));
    if (blockChildren.length === 0 && !el.querySelector('input, button, a, select, textarea, img')) {
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => (n.textContent ?? '').trim())
        .join('');
      if (directText.length < 20) return null;
    }
    return rect;
  }

  /** Determine if an element is a pure wrapper that should be skipped (not consume depth).
   *  Pre-computed values are passed in to avoid redundant DOM queries. */
  function isWrapper(
    el: HTMLElement,
    cs: CSSStyleDeclaration,
    textPreview: string,
    directInter: { inputs: number; buttons: number; links: number; images: number },
  ): boolean {
    if (el.id) return false;
    if (el.getAttribute('role')) return false;
    if (el.getAttribute('aria-label')) return false;
    if (el.getAttribute('aria-labelledby')) return false;
    if (el.hasAttribute('tabindex')) return false;
    if (SEMANTIC_TAGS.has(el.tagName)) return false;
    // Only fixed/absolute/sticky are meaningful positioning; relative is cosmetic
    if (cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky') return false;
    if (cs.zIndex !== 'auto' && cs.zIndex !== '0') return false;
    if (cs.overflow !== 'visible') return false;
    if (textPreview) return false;
    if (directInter.inputs + directInter.buttons + directInter.links + directInter.images > 0) return false;
    return true;
  }

  /** Fingerprint for detecting repeated sibling patterns. */
  function getSiblingKey(el: HTMLElement): string {
    const tag = el.tagName;
    const cls = (typeof el.className === 'string') ? el.className : '';
    const role = el.getAttribute('role') ?? '';
    return `${tag}|${cls}|${role}`;
  }

  /** Check if two outline nodes have similar structure (same tag, similar interactive profile). */
  function isSimilarStructure(a: OutlineNode, b: OutlineNode): boolean {
    if (a.tag !== b.tag) return false;
    // Same direct interactive profile
    if (a.inter.inputs !== b.inter.inputs || a.inter.buttons !== b.inter.buttons
      || a.inter.links !== b.inter.links || a.inter.images !== b.inter.images) return false;
    // Similar child count (within ±1)
    if (Math.abs(a.children.length - b.children.length) > 1) return false;
    return true;
  }

  interface OutlineNode {
    tag: string;
    sel: string;
    rect: { x: number; y: number; w: number; h: number };
    text: string;
    inter: { inputs: number; buttons: number; links: number; images: number };
    totalInter?: { inputs: number; buttons: number; links: number; images: number };
    clues: string[];
    style: { position: string; zIndex: string; overflow: string };
    children: OutlineNode[];
    /** If set, this node represents N collapsed siblings that were similar to previous nodes. */
    collapsedCount?: number;
    collapsedSelector?: string;
  }

  const SIBLING_SAMPLE_COUNT = 3;
  const SIBLING_COLLAPSE_THRESHOLD = 5;

  /** Generate a collapse key from an OutlineNode (for promoted nodes that have no DOM element). */
  function getNodeKey(node: OutlineNode): string {
    const cls = node.clues.find(c => c.startsWith('class='));
    const role = node.clues.find(c => c.startsWith('role='));
    return `${node.tag}|${cls ?? ''}|${role ?? ''}`;
  }

  /**
   * Traverse the DOM tree. `depth` counts meaningful nodes only.
   * `rawDepth` counts actual DOM nesting to prevent infinite recursion on wrapper chains.
   */
  function traverse(el: HTMLElement, depth: number, rawDepth: number): OutlineNode[] {
    if (depth > MAX_DEPTH || rawDepth > MAX_RAW_DEPTH || nodeCount >= MAX_NODES) return [];

    // Phase 1: collect all meaningful children (skipping wrappers)
    interface DomCandidate { type: 'dom'; el: HTMLElement; key: string; cs: CSSStyleDeclaration; textPreview: string; inter: ReturnType<typeof countDirectInteractive> }
    interface PromotedCandidate { type: 'promoted'; node: OutlineNode; key: string }
    type Candidate = DomCandidate | PromotedCandidate;

    const candidates: Candidate[] = [];
    for (const child of el.children) {
      if (nodeCount + candidates.length >= MAX_NODES + 50) break;
      if (!(child instanceof HTMLElement)) continue;

      const rect = getVisualRect(child);
      if (!rect) continue;

      const hasContent = (child.textContent?.trim().length ?? 0) > 0
        || child.querySelector('input, button, a, select, textarea, img') !== null;
      if (!hasContent) continue;

      const cs = getComputedStyle(child);
      const textPreview = getTextPreview(child);
      const inter = countDirectInteractive(child);

      if (isWrapper(child, cs, textPreview, inter)) {
        const promoted = traverse(child, depth, rawDepth + 1);
        candidates.push(...promoted.map(n => ({ type: 'promoted' as const, node: n, key: getNodeKey(n) })));
        continue;
      }

      candidates.push({ type: 'dom', el: child, key: getSiblingKey(child), cs, textPreview, inter });
    }

    // Phase 2: group by key, detect repeated patterns, collapse similar siblings
    const results: OutlineNode[] = [];
    const keyCount = new Map<string, number>();
    for (const c of candidates) {
      keyCount.set(c.key, (keyCount.get(c.key) ?? 0) + 1);
    }

    const keyEmitted = new Map<string, number>();
    const keySamples = new Map<string, OutlineNode[]>();

    for (const c of candidates) {
      if (nodeCount >= MAX_NODES) break;

      const count = keyCount.get(c.key)!;
      const emitted = keyEmitted.get(c.key) ?? 0;

      // Resolve candidate to an OutlineNode
      const resolveNode = (): OutlineNode => {
        if (c.type === 'promoted') return c.node;
        return buildNode(c.el, depth, rawDepth, c.cs, c.textPreview, c.inter);
      };

      if (count >= SIBLING_COLLAPSE_THRESHOLD) {
        if (emitted < SIBLING_SAMPLE_COUNT) {
          const node = resolveNode();
          results.push(node);
          keyEmitted.set(c.key, emitted + 1);
          const samples = keySamples.get(c.key) ?? [];
          samples.push(node);
          keySamples.set(c.key, samples);
        } else if (emitted === SIBLING_SAMPLE_COUNT) {
          const samples = keySamples.get(c.key) ?? [];
          const allSimilar = samples.length >= 2 && samples.every((s, i) =>
            i === 0 || isSimilarStructure(samples[0], s));

          if (allSimilar) {
            const remaining = count - SIBLING_SAMPLE_COUNT;
            const sampleNode = samples[0];
            const firstClass = sampleNode.clues.find(cl => cl.startsWith('class='));
            const clsSuffix = firstClass ? '.' + firstClass.slice(6).split(' ')[0] : '';
            const parentSel = c.type === 'dom'
              ? getSelector(c.el.parentElement!)
              : sampleNode.sel.replace(/ > [^>]+$/, '');
            results.push({
              tag: sampleNode.tag, sel: `(${remaining} more)`, text: '',
              rect: { x: 0, y: 0, w: 0, h: 0 }, inter: { inputs: 0, buttons: 0, links: 0, images: 0 },
              clues: [], style: { position: '', zIndex: '', overflow: '' }, children: [],
              collapsedCount: remaining,
              collapsedSelector: `${parentSel} > ${sampleNode.tag}${clsSuffix}`,
            });
            keyEmitted.set(c.key, emitted + 1);
          } else {
            const node = resolveNode();
            results.push(node);
            keyEmitted.set(c.key, emitted + 1);
            keyCount.set(c.key, SIBLING_COLLAPSE_THRESHOLD - 1);
          }
        }
        // else: already collapsed, skip
      } else {
        const node = resolveNode();
        results.push(node);
      }
    }

    return results;
  }

  /** Build an OutlineNode for a meaningful element using pre-computed values. */
  function buildNode(
    child: HTMLElement, depth: number, rawDepth: number,
    cs: CSSStyleDeclaration, textPreview: string, inter: ReturnType<typeof countDirectInteractive>,
  ): OutlineNode {
    nodeCount++;
    const style = {
      position: (cs.position === 'static' || cs.position === 'relative') ? '' : cs.position,
      zIndex: cs.zIndex === 'auto' ? '' : cs.zIndex,
      overflow: cs.overflow === 'visible' ? '' : cs.overflow,
    };
    return {
      tag: child.tagName.toLowerCase(),
      sel: getSelector(child),
      rect: (() => { const r = child.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      text: textPreview,
      inter,
      clues: getClues(child),
      style,
      children: traverse(child, depth + 1, rawDepth + 1),
    };
  }

  /** Post-traversal: compute total descendant interactive counts for display. */
  function computeTotalInter(nodes: OutlineNode[]): void {
    for (const node of nodes) {
      computeTotalInter(node.children);
      const totals = { ...node.inter };
      for (const child of node.children) {
        const ct = child.totalInter!;
        totals.inputs += ct.inputs;
        totals.buttons += ct.buttons;
        totals.links += ct.links;
        totals.images += ct.images;
      }
      node.totalInter = totals;
    }
  }

  function formatNode(node: OutlineNode, indent: number): string[] {
    const pad = '  '.repeat(indent);

    // Collapsed sibling summary
    if (node.collapsedCount) {
      return [`${pad}... ${node.collapsedCount} more similar <${node.tag}> (selector: ${node.collapsedSelector})`];
    }

    const ti = node.totalInter ?? node.inter;

    const interParts: string[] = [];
    if (ti.inputs) interParts.push(ti.inputs + ' input');
    if (ti.buttons) interParts.push(ti.buttons + ' btn');
    if (ti.links) interParts.push(ti.links + ' link');
    if (ti.images) interParts.push(ti.images + ' img');
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

  const tree = traverse(root, 0, 0);
  computeTotalInter(tree);
  const totalInter = countAllInteractive(root);

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
    'Extract content from a browser tab (defaults to the active tab). ' +
    'Modes: "markdown" (default, full-page as markdown — works for any page), ' +
    '"article" (reader-mode extraction as markdown — for news/blogs/docs), ' +
    '"outline" (page structure overview — visual regions with selectors, positions, interactive elements; use to understand layout before acting), ' +
    '"text" (plain text), "html" (cleaned HTML). ' +
    'Optionally scope to a CSS selector. ' +
    'Use this before answering questions about page content.',
  parameters: ReadPageParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    const tabId = await resolveTabId(params.tabId);
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

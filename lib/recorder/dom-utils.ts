// Shared DOM helpers used by the recorder content script.
//
// IMPORTANT: `lib/tools/inspect.ts` keeps a functionally equivalent INLINE copy
// of `buildSelector`, `getRole`, and `getLabel` because it is injected into
// pages via `chrome.scripting.executeScript({ func })`, which serializes the
// function source and drops all `import` references. If you change selector
// generation, role mapping, or label resolution semantics here, mirror the
// change in `inspect.ts`. A future refactor (tracked in plan
// 2026-04-22-recording-button.md "Out-of-band notes") may unify both via a
// dedicated entrypoint script and remove this duplication.
//
// The recorder's content script is a WXT entrypoint (built as a standalone
// bundle and injected via `files: [...]`), so normal imports work here.

import { SEMANTIC_ROLES, SEMANTIC_TAGS, TEXT_PREVIEW_MAX } from './constants';
import type { MutationChange } from './types';

// ─── Selector ─────────────────────────────────────────────────────────

/** Absolute CSS selector path from `body`/`html` to the given element.
 *  Stops early at the nearest ancestor with an `id` to keep selectors short
 *  and resilient. Mirrors `inspect.ts`'s inline implementation. */
export function buildSelector(el: Element): string {
  const path: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.body && node !== document.documentElement) {
    let seg = node.tagName.toLowerCase();
    if (node.id) {
      seg = '#' + CSS.escape(node.id);
      path.unshift(seg);
      return path.join(' > ');
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      const tagName = node.tagName;
      const sibs = Array.from(parent.children).filter((c: Element) => c.tagName === tagName);
      if (sibs.length > 1) {
        seg += `:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
    }
    path.unshift(seg);
    node = parent;
  }
  if (node === document.body) path.unshift('body');
  else if (node === document.documentElement) path.unshift('html');
  return path.join(' > ');
}

// ─── Role ─────────────────────────────────────────────────────────────

const IMPLICIT_ROLES: Record<string, string> = {
  a: 'link', button: 'button', input: 'textbox', select: 'combobox', textarea: 'textbox',
  nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
  aside: 'complementary', article: 'article', section: 'region',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  img: 'img', ul: 'list', ol: 'list', li: 'listitem', table: 'table',
  tr: 'row', td: 'cell', th: 'columnheader', form: 'form', dialog: 'dialog',
};

/** Returns the element's ARIA role (explicit `role` attribute wins),
 *  falling back to the implicit role for the tag. Mirrors `inspect.ts`. */
export function getRole(el: Element): string | undefined {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type;
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    if (type === 'search') return 'searchbox';
    return 'textbox';
  }
  if (tag === 'a' && !el.hasAttribute('href')) return undefined;
  return IMPLICIT_ROLES[tag];
}

// ─── Label ────────────────────────────────────────────────────────────

/** Best-effort accessible name. Order:
 *  aria-labelledby > aria-label > <label for> / wrapping <label> > placeholder
 *  > alt > title > short visible text (buttons/links only).
 *  All branches are truncated at TEXT_PREVIEW_MAX so the recorder never
 *  emits arbitrarily long labels. Mirrors `inspect.ts` semantically; the
 *  truncation is the only intentional difference. */
export function getLabel(el: Element, cachedInnerText?: string): string | undefined {
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const parts = labelledby.split(/\s+/)
      .map(id => document.getElementById(id)?.textContent?.trim())
      .filter(Boolean);
    if (parts.length) return truncate(parts.join(' '), TEXT_PREVIEW_MAX);
  }
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return truncate(ariaLabel.trim(), TEXT_PREVIEW_MAX);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl?.textContent) return truncate(lbl.textContent.trim(), TEXT_PREVIEW_MAX);
    }
    if (!(el instanceof HTMLSelectElement)) {
      const wrap = el.closest('label');
      if (wrap?.textContent) return truncate(wrap.textContent.trim(), TEXT_PREVIEW_MAX);
    }
    const ph = (el as HTMLInputElement).placeholder;
    if (ph) return truncate(ph, TEXT_PREVIEW_MAX);
  }
  const alt = el.getAttribute('alt');
  if (alt) return truncate(alt, TEXT_PREVIEW_MAX);
  const title = el.getAttribute('title');
  if (title) return truncate(title, TEXT_PREVIEW_MAX);
  const tag = el.tagName.toLowerCase();
  if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') {
    // The 80-char gate is inherited from inspect.ts; the truncate is
    // belt-and-suspenders in case future callers loosen the gate.
    const t = (cachedInnerText ?? (el as HTMLElement).innerText ?? '').trim();
    if (t && t.length <= 80) return truncate(t, TEXT_PREVIEW_MAX);
  }
  return undefined;
}

// ─── Text preview ─────────────────────────────────────────────────────

const TEXT_PREVIEW_SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

/** Visible inner text, collapsed and truncated. Returns `undefined` for empty.
 *  Falls back to `textContent` when `innerText` is unavailable (e.g. SVG /
 *  MathML elements that the recorder may legitimately encounter inside dialogs). */
export function getTextPreview(
  el: Element,
  max: number = TEXT_PREVIEW_MAX,
  cachedInnerText?: string,
): string | undefined {
  if (TEXT_PREVIEW_SKIP_TAGS.has(el.tagName)) return undefined;
  const raw = cachedInnerText ?? (el as HTMLElement).innerText ?? el.textContent ?? '';
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  return truncate(collapsed, max);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// ─── Recorder-specific helpers ────────────────────────────────────────

/** Whether an element qualifies as a "semantic container" — used to decide
 *  if its appearance/disappearance is worth recording. Matches the plan:
 *  role in SEMANTIC_ROLES || tag in SEMANTIC_TAGS || has aria-label
 *  || has aria-modal=true. */
export function isSemanticContainer(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (SEMANTIC_TAGS.has(tag)) return true;
  const role = el.getAttribute('role');
  if (role && SEMANTIC_ROLES.has(role)) return true;
  if (el.hasAttribute('aria-label')) return true;
  if (el.getAttribute('aria-modal') === 'true') return true;
  return false;
}

/** Bounding rect size in CSS pixels (rounded). Triggers layout. */
export function getElementSize(el: Element): { w: number; h: number } {
  const r = el.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
}

/** Viewport area in CSS pixels squared. */
export function getViewportArea(): number {
  return window.innerWidth * window.innerHeight;
}

/** Whether the rect covers at least `ratio` of the viewport. Accepts a rect
 *  so callers can share a single `getBoundingClientRect()` read. */
export function rectMeetsAreaThreshold(
  rect: { width: number; height: number },
  viewportArea: number,
  ratio: number,
): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  return (rect.width * rect.height) >= viewportArea * ratio;
}

/** One-shot area test that reads the rect itself. Triggers layout — prefer
 *  `rectMeetsAreaThreshold` when the caller already has the rect. */
export function meetsAreaThreshold(el: Element, viewportArea: number, ratio: number): boolean {
  return rectMeetsAreaThreshold(el.getBoundingClientRect(), viewportArea, ratio);
}

/** Convenience: read all fields the recorder cares about for a node, sharing
 *  a single layout read and a single `innerText` read. The optional `rect`
 *  arg lets callers thread through a rect they already obtained (e.g. from
 *  `meetsAreaThreshold`), avoiding a second forced reflow. */
export function describeNode(
  el: Element,
  rect?: DOMRect,
): Omit<MutationChange, 'op'> {
  const innerText = (el as HTMLElement).innerText ?? '';
  const r = rect ?? el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(),
    role: getRole(el),
    label: getLabel(el, innerText),
    textPreview: getTextPreview(el, TEXT_PREVIEW_MAX, innerText),
    size: { w: Math.round(r.width), h: Math.round(r.height) },
    childCount: el.childElementCount,
  };
}
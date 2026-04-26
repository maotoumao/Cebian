import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_INSPECT } from '@/lib/types';
import { executeInTabWithArgs } from '@/lib/tab-helpers';

// ─── Parameters ───

const InspectParameters = Type.Object({
  selector: Type.Optional(Type.String({
    description:
      'CSS selector to inspect. ' +
      'If omitted and `text` is provided: search the whole page for elements containing the text. ' +
      'If both omitted: inspect document.body (page overview). ' +
      'If both provided: filter selector matches by text substring.',
  })),
  text: Type.Optional(Type.String({
    description:
      'Substring filter (case-insensitive). ' +
      'Without `selector`: returns the deepest elements whose own text contains the substring. ' +
      'With `selector`: keeps only matches whose innerText contains the substring.',
  })),
  attrs: Type.Optional(Type.Union(
    [Type.Literal('default'), Type.Literal('verbose')],
    {
      description:
        '"default" (recommended): omit aria-*, inline style, framework-internal data-*, and atomic Tailwind classes — accessibility info already lives in `role`/`label`/`state`. ' +
        '"verbose": return every attribute as-is. Use only when the default mode hides something you need.',
    },
  )),
  children: Type.Optional(Type.Union(
    [Type.Literal('none'), Type.Literal('interactive')],
    {
      description:
        '"none" (default): return only the matched element(s). ' +
        '"interactive": also enumerate descendant interactive controls (button, link, input, select, textarea, [role=button|link|menuitem|tab|checkbox|radio|switch|option], [tabindex], [contenteditable]) with absolute selectors so you can target them directly.',
    },
  )),
  limit: Type.Optional(Type.Number({
    description: 'Max top-level elements to return. Default: 20. Use -1 to return all.',
  })),
  frameId: Type.Optional(Type.Number({
    description: 'Frame ID to inspect. Omit for top frame. Use tab({ action: "list_frames" }) to discover IDs.',
  })),
  tabId: Type.Number({
    description: 'Required. Tab ID to inspect. Read it from the `tabId:` line under `[Active Tab]` (or the windows list) in the context block. Never omit.',
  }),
});

// ─── In-page inspection function (self-contained, runs via executeInTabWithArgs) ───

function performInspect(params: {
  selector?: string;
  text?: string;
  attrs?: 'default' | 'verbose';
  children?: 'none' | 'interactive';
  limit?: number;
}): string {
  const {
    selector,
    text,
    children = 'none',
    limit = 20,
  } = params;
  const attrsMode: 'default' | 'verbose' = params.attrs ?? 'default';

  const INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="option"]',
    '[role="combobox"]', '[role="textbox"]', '[role="searchbox"]', '[role="slider"]',
    '[tabindex]:not([tabindex="-1"])', '[contenteditable=""]', '[contenteditable="true"]',
  ].join(',');

  const TEXT_TRUNCATE = 200;

  // ── Tailwind class filter ─────────────────────────────────────────────
  // Strip atomic Tailwind utilities while keeping semantic / component class names.
  // Heuristic: drop classes containing variant prefix (`:` like `hover:bg-red-500`)
  // or matching a known utility prefix.
  const TW_PREFIXES = new Set([
    'flex', 'grid', 'block', 'inline', 'inline-block', 'inline-flex', 'inline-grid',
    'hidden', 'static', 'fixed', 'absolute', 'relative', 'sticky', 'visible', 'invisible',
    'table', 'contents', 'flow-root', 'isolate', 'isolation-auto',
    'p', 'px', 'py', 'pt', 'pb', 'pl', 'pr', 'ps', 'pe',
    'm', 'mx', 'my', 'mt', 'mb', 'ml', 'mr', 'ms', 'me',
    'gap', 'gap-x', 'gap-y',
    'space-x', 'space-y', 'divide', 'divide-x', 'divide-y',
    'w', 'min-w', 'max-w', 'h', 'min-h', 'max-h', 'size',
    'top', 'bottom', 'left', 'right', 'inset', 'inset-x', 'inset-y', 'start', 'end', 'z',
    'text', 'font', 'tracking', 'leading', 'whitespace', 'break', 'truncate',
    'line-clamp', 'list', 'list-image', 'placeholder', 'caret', 'accent', 'selection',
    'underline', 'overline', 'no-underline', 'line-through', 'italic', 'not-italic',
    'uppercase', 'lowercase', 'capitalize', 'normal-case', 'antialiased', 'subpixel-antialiased',
    'bg', 'from', 'via', 'to', 'fill', 'stroke',
    'border', 'border-x', 'border-y', 'border-t', 'border-b', 'border-l', 'border-r',
    'border-s', 'border-e', 'rounded', 'rounded-t', 'rounded-b', 'rounded-l', 'rounded-r',
    'rounded-tl', 'rounded-tr', 'rounded-bl', 'rounded-br', 'rounded-ss', 'rounded-se', 'rounded-es', 'rounded-ee',
    'shadow', 'opacity', 'mix-blend', 'bg-blend',
    'cursor', 'select', 'pointer-events', 'resize', 'appearance', 'scroll',
    'outline', 'ring', 'ring-offset', 'ring-inset',
    'transition', 'duration', 'delay', 'ease', 'animate',
    'transform', 'scale', 'scale-x', 'scale-y', 'rotate', 'translate-x', 'translate-y',
    'skew-x', 'skew-y', 'origin', 'perspective', 'perspective-origin',
    'backdrop', 'filter', 'blur', 'brightness', 'contrast', 'drop-shadow',
    'grayscale', 'invert', 'saturate', 'sepia', 'hue-rotate',
    'order', 'col', 'col-span', 'col-start', 'col-end', 'row', 'row-span', 'row-start', 'row-end',
    'grid-cols', 'grid-rows', 'grid-flow', 'auto-cols', 'auto-rows',
    'justify', 'justify-items', 'justify-self',
    'content', 'items', 'self', 'place', 'place-content', 'place-items', 'place-self',
    'flex-1', 'flex-auto', 'flex-none', 'flex-row', 'flex-col', 'flex-wrap', 'flex-nowrap',
    'flex-row-reverse', 'flex-col-reverse', 'flex-wrap-reverse',
    'grow', 'shrink', 'basis',
    'object', 'object-contain', 'object-cover', 'object-fill', 'object-none', 'object-scale-down',
    'overflow', 'overflow-x', 'overflow-y', 'overscroll', 'overscroll-x', 'overscroll-y',
    'aspect', 'columns',
    'sr-only', 'not-sr-only',
    'group', 'peer',
    'container',
    'float', 'clear',
    'will-change', 'touch', 'snap', 'scroll-snap',
  ]);
  const isTailwindClass = (cls: string): boolean => {
    // Variant prefix? `hover:bg-red-500`, `md:flex`, `dark:text-white`
    if (cls.includes(':')) return true;
    // Negative prefix `-mt-2` → `mt-2`
    const stripped = cls.startsWith('-') ? cls.slice(1) : cls;
    // Arbitrary value `[w-100px]` etc.
    if (stripped.startsWith('[') && stripped.endsWith(']')) return true;
    // Group/peer with name `group/foo`, `peer/bar`
    if (/^(?:group|peer)\//.test(stripped)) return true;
    // Exact match (e.g. `flex`, `truncate`, `container`, `sr-only`)
    if (TW_PREFIXES.has(stripped)) return true;
    // Prefix match `<prefix>-<rest>`
    const dash = stripped.indexOf('-');
    if (dash > 0) {
      const prefix = stripped.slice(0, dash);
      if (TW_PREFIXES.has(prefix)) return true;
    }
    return false;
  };

  const filterClassAttr = (value: string): string => {
    const kept = value.split(/\s+/).filter(c => c && !isTailwindClass(c));
    return kept.join(' ');
  };

  // ── Attribute filter ──────────────────────────────────────────────────
  const FRAMEWORK_DATA_PREFIXES = ['data-radix', 'data-state', 'data-headlessui', 'data-floating', 'data-slot', 'data-orientation', 'data-side', 'data-align', 'data-reach', 'data-v-', 'data-react', 'data-svelte'];
  const isFrameworkData = (name: string): boolean => {
    if (!name.startsWith('data-')) return false;
    return FRAMEWORK_DATA_PREFIXES.some(p => name.startsWith(p));
  };

  const collectAttrs = (el: Element, mode: 'default' | 'verbose'): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name;
      const value = attr.value;
      if (mode === 'verbose') {
        out[name] = value;
        continue;
      }
      // Default mode: drop noise
      if (name === 'style') continue;
      if (name.startsWith('aria-')) continue;
      if (isFrameworkData(name)) continue;
      // Long hash-like data-* (likely framework-internal)
      if (name.startsWith('data-') && /^[a-z0-9-]{20,}$/i.test(name.slice(5))) continue;
      if (name === 'class') {
        const filtered = filterClassAttr(value);
        if (filtered) out.class = filtered;
        continue;
      }
      out[name] = value;
    }
    return out;
  };

  // ── Absolute CSS selector path ────────────────────────────────────────
  const buildSelector = (el: Element): string => {
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
  };

  // ── Role / label / state ──────────────────────────────────────────────
  const IMPLICIT_ROLES: Record<string, string> = {
    a: 'link', button: 'button', input: 'textbox', select: 'combobox', textarea: 'textbox',
    nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
    aside: 'complementary', article: 'article', section: 'region',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    img: 'img', ul: 'list', ol: 'list', li: 'listitem', table: 'table',
    tr: 'row', td: 'cell', th: 'columnheader', form: 'form', dialog: 'dialog',
  };
  const getRole = (el: Element): string | undefined => {
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
  };

  const getLabel = (el: Element): string | undefined => {
    // aria-labelledby > aria-label > <label for> / wrapping <label> > alt > title > visible text (short)
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = labelledby.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl?.textContent) return lbl.textContent.trim();
      }
      // Skip wrapping <label> for <select> — concatenated <option> text is noise.
      if (!(el instanceof HTMLSelectElement)) {
        const wrap = el.closest('label');
        if (wrap?.textContent) return wrap.textContent.trim();
      }
      const ph = (el as HTMLInputElement).placeholder;
      if (ph) return ph;
    }
    const alt = el.getAttribute('alt');
    if (alt) return alt;
    const title = el.getAttribute('title');
    if (title) return title;
    // Fallback to short visible text for buttons/links
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') {
      const t = (el as HTMLElement).innerText?.trim() ?? '';
      if (t && t.length <= 80) return t;
    }
    return undefined;
  };

  const getState = (el: Element): Record<string, unknown> | undefined => {
    const state: Record<string, unknown> = {};
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.value !== undefined && el.value !== '') state.value = el.value.length > 100 ? el.value.slice(0, 100) + '…' : el.value;
      if (el.disabled) state.disabled = true;
      if (el.readOnly) state.readonly = true;
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        state.checked = el.checked;
      }
    }
    if (el instanceof HTMLSelectElement) {
      if (el.value) state.value = el.value;
      if (el.disabled) state.disabled = true;
    }
    if (el instanceof HTMLOptionElement) {
      if (el.selected) state.selected = true;
      if (el.disabled) state.disabled = true;
    }
    // ARIA only when native didn't already set the field (native is source of truth).
    const ariaChecked = el.getAttribute('aria-checked');
    if (ariaChecked != null && state.checked === undefined) state.checked = ariaChecked === 'true' ? true : ariaChecked === 'mixed' ? 'mixed' : false;
    const ariaSelected = el.getAttribute('aria-selected');
    if (ariaSelected != null && state.selected === undefined) state.selected = ariaSelected === 'true';
    const ariaDisabled = el.getAttribute('aria-disabled');
    if (ariaDisabled === 'true' && state.disabled === undefined) state.disabled = true;
    if (el.hasAttribute('disabled') && state.disabled === undefined) state.disabled = true;
    const ariaPressed = el.getAttribute('aria-pressed');
    if (ariaPressed != null) state.pressed = ariaPressed === 'true';
    const ariaExpanded = el.getAttribute('aria-expanded');
    if (ariaExpanded != null) state.expanded = ariaExpanded === 'true';
    const ariaReadonly = el.getAttribute('aria-readonly');
    if (ariaReadonly === 'true' && state.readonly === undefined) state.readonly = true;
    if (document.activeElement === el) state.focused = true;
    return Object.keys(state).length ? state : undefined;
  };

  /**
   * Visibility analysis with a specific `hidden` reason so the agent can decide what to do
   * (e.g. `opacity-zero` → element is state-controlled, trigger the UI that reveals it;
   * `transparent` → likely mid-animation, wait and retry; `pointerEventsNone` → visually
   * visible but click-through, target a different element).
   *
   *  - `display-none`        — not in layout at all
   *  - `visibility-hidden`   — reserves space but not painted (covers `visibility: collapse` too)
   *  - `opacity-zero`        — exactly 0, developer-intent hidden
   *  - `transparent`         — (0, 0.1], near-invisible (animation frame / rounding)
   *  - `zero-size`           — rect has zero width or height
   *  - `ancestor-hidden`     — self looks fine but an ancestor is display:none /
   *                            visibility:hidden / opacity:0
   *  `pointerEventsNone` is orthogonal: reported whenever set, even on visible elements.
   */
  type HiddenReason = 'display-none' | 'visibility-hidden' | 'opacity-zero'
    | 'transparent' | 'zero-size' | 'ancestor-hidden';
  interface VisInfo {
    visible: boolean;
    hidden?: HiddenReason;
    pointerEventsNone?: true;
  }
  const getVisibility = (el: Element): VisInfo => {
    if (!(el instanceof Element)) return { visible: true };

    const cs = getComputedStyle(el);
    const pe: { pointerEventsNone?: true } = cs.pointerEvents === 'none'
      ? { pointerEventsNone: true } : {};

    // Self-level reasons take precedence over ancestor reasons: knowing the *own* style
    // is the more actionable info for the agent.
    if (cs.display === 'none') return { visible: false, hidden: 'display-none', ...pe };
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') {
      return { visible: false, hidden: 'visibility-hidden', ...pe };
    }
    const op = parseFloat(cs.opacity);
    if (Number.isFinite(op)) {
      if (op === 0) return { visible: false, hidden: 'opacity-zero', ...pe };
      if (op <= 0.1) return { visible: false, hidden: 'transparent', ...pe };
    }

    // Ancestor walk MUST come before geometry: an ancestor with `display:none` makes the
    // descendant's `getClientRects()` empty, which would otherwise be misreported as
    // `zero-size`. `offsetParent` only catches display:none, so we walk the whole chain
    // to also detect visibility:hidden/collapse and opacity:0 ancestors.
    for (let cur: Element | null = el.parentElement; cur; cur = cur.parentElement) {
      const acs = getComputedStyle(cur);
      if (acs.display === 'none' || acs.visibility === 'hidden' || acs.visibility === 'collapse') {
        return { visible: false, hidden: 'ancestor-hidden', ...pe };
      }
      const aop = parseFloat(acs.opacity);
      if (Number.isFinite(aop) && aop === 0) {
        return { visible: false, hidden: 'ancestor-hidden', ...pe };
      }
    }

    // `display: contents` generates no box of its own but its children are paintable.
    // Skip the zero-size check for it — the element is "visible" in the sense the agent
    // cares about (children render, events bubble).
    if (cs.display === 'contents') return { visible: true, ...pe };

    const rects = el.getClientRects();
    if (rects.length === 0) return { visible: false, hidden: 'zero-size', ...pe };
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { visible: false, hidden: 'zero-size', ...pe };

    return { visible: true, ...pe };
  };

  // ── Per-element snapshot ──────────────────────────────────────────────
  const snapshotElement = (el: Element, opts: { includeChildren: boolean }): Record<string, unknown> => {
    const tag = el.tagName.toLowerCase();
    const role = getRole(el);
    const label = getLabel(el);
    const state = getState(el);
    const attrs = collectAttrs(el, attrsMode);
    const rect = el.getBoundingClientRect();
    const vis = getVisibility(el);
    const innerText = (el as HTMLElement).innerText?.trim() ?? '';
    const includeText = innerText && innerText !== label;
    const out: Record<string, unknown> = {
      selector: buildSelector(el),
      tag,
    };
    if (role) out.role = role;
    if (label) out.label = label;
    if (state) out.state = state;
    if (includeText) {
      out.text = innerText.length > TEXT_TRUNCATE ? innerText.slice(0, TEXT_TRUNCATE) + '…' : innerText;
    }
    out.visible = vis.visible;
    if (vis.hidden) out.hidden = vis.hidden;
    if (vis.pointerEventsNone) out.pointerEventsNone = true;
    out.rect = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
    if (Object.keys(attrs).length) out.attrs = attrs;
    if (opts.includeChildren) {
      const CHILDREN_LIMIT = 50;
      const interactive = Array.from(el.querySelectorAll(INTERACTIVE_SELECTOR));
      const childrenCapped = interactive.slice(0, CHILDREN_LIMIT);
      out.children = childrenCapped.map(c => {
        const cTag = c.tagName.toLowerCase();
        const cRole = getRole(c);
        const cLabel = getLabel(c);
        const cState = getState(c);
        const cVis = getVisibility(c);
        const item: Record<string, unknown> = {
          selector: buildSelector(c),
          tag: cTag,
        };
        if (cRole) item.role = cRole;
        if (cLabel) item.label = cLabel;
        if (cState) item.state = cState;
        item.visible = cVis.visible;
        if (cVis.hidden) item.hidden = cVis.hidden;
        if (cVis.pointerEventsNone) item.pointerEventsNone = true;
        return item;
      });
      if (interactive.length > childrenCapped.length) {
        out.childrenTruncated = true;
        out.childrenTotal = interactive.length;
      }
    }
    return out;
  };

  // ── Resolve target element(s) ─────────────────────────────────────────
  let targets: Element[];
  if (selector) {
    targets = Array.from(document.querySelectorAll(selector));
    if (text) {
      const needle = text.toLowerCase();
      targets = targets.filter(el => {
        const txt = (el as HTMLElement).innerText?.toLowerCase() ?? '';
        return txt.includes(needle);
      });
    }
  } else if (text) {
    // find-by-text: deepest elements whose own text contains the substring.
    // Skip script/style/noscript/template noise.
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const needle = text.toLowerCase();
    const set = new Set<Element>();
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node: Node): number {
          const parent = (node as Text).parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const txt = node.textContent ?? '';
      if (txt.toLowerCase().includes(needle)) {
        const parent = (node as Text).parentElement;
        if (parent) set.add(parent);
      }
    }
    // Drop ancestors of any other matched element — keep deepest only.
    const candidates = Array.from(set);
    targets = candidates.filter(el => !candidates.some(other => other !== el && el.contains(other)));
  } else {
    targets = [document.body];
  }

  if (targets.length === 0) {
    return JSON.stringify({
      count: 0,
      elements: [],
      hint: selector
        ? `No element matches selector: ${selector}${text ? ` containing "${text}"` : ''}`
        : `No element contains text: "${text}"`,
    });
  }

  const total = targets.length;
  const capped = limit < 0 ? targets : targets.slice(0, limit);
  const elements = capped.map(el => snapshotElement(el, { includeChildren: children === 'interactive' }));

  return JSON.stringify({
    count: total,
    returned: capped.length,
    truncated: total > capped.length,
    elements,
  });
}

// ─── Tool definition ───

export const inspectTool: AgentTool<typeof InspectParameters> = {
  name: TOOL_INSPECT,
  label: 'Inspect',
  description:
    'Inspect DOM elements precisely without taking a screenshot. Returns a structured snapshot — absolute CSS selector, tag, ARIA role, accessible label, state (value/checked/selected/disabled/pressed/expanded/readonly/focused), visibility, viewport rect, and filtered attributes. ' +
    'Visibility fields: `visible` (boolean — truly paintable, non-zero size, no hiding ancestor). When `visible: false`, a `hidden` reason is attached: `display-none` (not in layout — trigger the UI that shows it), `visibility-hidden`, `opacity-zero` (developer-intent hidden, state-controlled), `transparent` (opacity in (0, 0.1], likely mid-animation — retry shortly), `zero-size`, `ancestor-hidden`. ' +
    '`pointerEventsNone: true` is reported whenever `pointer-events: none` is set — such elements are visually present but click-through; target a different element instead. ' +
    'PREFER THIS over `screenshot` for understanding page structure and for any element discovery — it is faster, deterministic, and gives the model selectors it can act on directly via `interact`. ' +
    'Modes: ' +
    '(a) `selector` only → query that selector; ' +
    '(b) `text` only → find the deepest elements whose text contains the substring; ' +
    '(c) `selector` + `text` → filter selector matches by text; ' +
    '(d) neither → snapshot of `body` (page overview). ' +
    'Use `children: "interactive"` to also enumerate descendant buttons/links/inputs (each with its own absolute selector, ready to feed into `interact`). ' +
    'Use `attrs: "verbose"` only when the default filter hides something you need (default mode strips aria-*, inline style, framework data-*, and Tailwind utility classes — that information is already in role/label/state).',
  parameters: InspectParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    try {
      const result = await executeInTabWithArgs(params.tabId, performInspect, [params], params.frameId);
      return {
        content: [{ type: 'text', text: result }],
        details: { status: 'done' },
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        details: { status: 'error' },
      };
    }
  },
};

import type { ElementAttachment } from './attachments';
import { getActiveTabId } from '@/lib/tab-helpers';

// ─── Injected picker script (self-contained, runs in content-script isolated world) ───
// IMPORTANT: This function must be fully self-contained — no closures over external variables.

function createPickerInPage() {
  // Guard: prevent double injection. Also clean up any orphaned remnants from
  // a crashed previous session so we never end up with a stale cursor style.
  if (document.getElementById('cebian-picker-host')) return;
  document.getElementById('cebian-picker-cursor')?.remove();

  // ── Shadow DOM host ──
  // The host has pointer-events:auto with a full-viewport overlay inside the
  // shadow root. Hit-testing stops at the overlay so page element-level
  // handlers (on the underlying <a>, <img>, etc.) are never invoked.
  // NOTE: pointer/mouse/click/wheel/touch events are *composed* and still
  // cross the shadow boundary to bubble/capture at window/document (retargeted
  // to the host). Page-registered window-capture listeners can therefore still
  // fire. We also install defensive window-capture listeners below to swallow
  // such events when their composedPath includes our shadow tree.
  const host = document.createElement('div');
  host.id = 'cebian-picker-host';
  host.style.cssText = 'all:initial !important;position:fixed !important;inset:0 !important;pointer-events:auto !important;z-index:2147483647 !important;';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'closed' });

  // Inject crosshair cursor into page (removed on cleanup)
  const cursorStyle = document.createElement('style');
  cursorStyle.id = 'cebian-picker-cursor';
  cursorStyle.textContent = '*, *::before, *::after { cursor: crosshair !important; }';
  document.head.appendChild(cursorStyle);

  // ── Shadow DOM UI ──
  const style = document.createElement('style');
  style.textContent = `
    .overlay {
      position: fixed;
      inset: 0;
      pointer-events: auto;
      z-index: 1;
      background: transparent;
    }
    .highlight {
      position: fixed;
      pointer-events: none;
      z-index: 2;
      border: 2px solid #e8a43a;
      background: rgba(232, 164, 58, 0.08);
      border-radius: 2px;
      transition: top .05s ease-out, left .05s ease-out, width .05s ease-out, height .05s ease-out;
    }
    .tooltip {
      position: fixed;
      pointer-events: none;
      z-index: 3;
      display: flex;
      align-items: baseline;
      gap: 6px;
      background: #1c1d25;
      color: #e8e4df;
      border: 1px solid rgba(232, 164, 58, 0.3);
      padding: 3px 8px;
      border-radius: 4px;
      font: 11px/1.4 'SF Mono', 'Cascadia Code', Consolas, monospace;
      max-width: 320px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    }
    .tooltip-dim { color: #8a8d9b; font-size: 10px; }
  `;
  shadow.appendChild(style);

  // Full-viewport overlay that absorbs all pointer events before the page sees them.
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  shadow.appendChild(overlay);

  const highlightEl = document.createElement('div');
  highlightEl.className = 'highlight';
  highlightEl.style.display = 'none';
  shadow.appendChild(highlightEl);

  const tooltipEl = document.createElement('div');
  tooltipEl.className = 'tooltip';
  tooltipEl.style.display = 'none';
  const tooltipLabel = document.createElement('span');
  const tooltipDims = document.createElement('span');
  tooltipDims.className = 'tooltip-dim';
  tooltipEl.appendChild(tooltipLabel);
  tooltipEl.appendChild(tooltipDims);
  shadow.appendChild(tooltipEl);

  let currentEl: Element | null = null;

  // ── Underlying element lookup ──
  // Temporarily disable hit-testing on BOTH the host and the overlay so
  // `elementFromPoint` returns the real page element. Toggling both is
  // belt-and-suspenders — `pointer-events` doesn't cascade to descendants, so
  // relying on host alone could miss edge cases where the overlay is hit-tested
  // independently. Restored synchronously, no repaint required.
  function getUnderlyingElement(x: number, y: number): Element | null {
    host.style.pointerEvents = 'none';
    overlay.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    host.style.pointerEvents = 'auto';
    overlay.style.pointerEvents = 'auto';
    if (!el || el === host || el === document.documentElement) return null;
    return el;
  }

  // ── Selector: minimal unique CSS selector ──
  function computeSelector(el: Element): string {
    // Try id (verify uniqueness — some pages have duplicate IDs)
    if (el.id) {
      const esc = CSS.escape(el.id);
      try { if (document.querySelectorAll('#' + esc).length === 1) return '#' + esc; } catch { /* invalid id */ }
    }

    const parts: string[] = [];
    let cur: Element | null = el;

    while (cur && cur !== document.body && cur !== document.documentElement) {
      // Shortcut: anchor to nearest unique-id ancestor
      if (cur !== el && cur.id) {
        const esc = CSS.escape(cur.id);
        try {
          if (document.querySelectorAll('#' + esc).length === 1) {
            parts.unshift('#' + esc);
            break;
          }
        } catch { /* skip */ }
      }

      const tag = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(tag); break; }

      const sameTag = Array.from(parent.children).filter((c: Element) => c.tagName === cur!.tagName);
      if (sameTag.length === 1) {
        parts.unshift(tag);
      } else {
        parts.unshift(tag + ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')');
      }
      cur = parent;
    }

    const sel = parts.join(' > ');
    // Verify uniqueness
    try { if (document.querySelectorAll(sel).length === 1) return sel; } catch { /* fall through */ }

    // Fallback: absolute nth-child path from body
    const fb: string[] = [];
    cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const p: Element | null = cur.parentElement;
      if (!p) break;
      fb.unshift(cur.tagName.toLowerCase() + ':nth-child(' + (Array.from(p.children).indexOf(cur) + 1) + ')');
      cur = p;
    }
    return 'body > ' + fb.join(' > ');
  }

  // ── Path: full DOM path from <html> root ──
  function computePath(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;

    while (cur) {
      const tag = cur.tagName.toLowerCase();
      let label = tag;

      if (cur.id) {
        label += '#' + cur.id;
      } else if (cur.classList.length > 0) {
        label += '.' + Array.from(cur.classList).slice(0, 2).join('.');
      } else if (cur.parentElement) {
        const sameTag = Array.from(cur.parentElement.children).filter(c => c.tagName === cur!.tagName);
        if (sameTag.length > 1) {
          label += ':nth-child(' + (Array.from(cur.parentElement.children).indexOf(cur) + 1) + ')';
        }
      }

      parts.unshift(label);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  // ── Attributes ──
  function collectAttributes(el: Element): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const a of el.attributes) {
      const n = a.name;
      // Skip framework internals
      if (n.startsWith('data-v-') || n.startsWith('_ngcontent') || n.startsWith('__react')) continue;
      // Truncate excessively long values
      attrs[n] = a.value.length > 200 ? a.value.slice(0, 200) + '…' : a.value;
    }
    return attrs;
  }

  // ── Event: pointermove on overlay — track hovered element ──
  function onPointerMove(e: PointerEvent) {
    const target = getUnderlyingElement(e.clientX, e.clientY);
    if (!target) {
      highlightEl.style.display = 'none';
      tooltipEl.style.display = 'none';
      currentEl = null;
      return;
    }

    currentEl = target;
    const rect = target.getBoundingClientRect();

    // Highlight box
    highlightEl.style.display = 'block';
    highlightEl.style.left = rect.left + 'px';
    highlightEl.style.top = rect.top + 'px';
    highlightEl.style.width = rect.width + 'px';
    highlightEl.style.height = rect.height + 'px';

    // Tooltip content
    const tag = target.tagName.toLowerCase();
    const id = target.id ? '#' + target.id : '';
    const cls = target.classList.length > 0
      ? '.' + Array.from(target.classList).slice(0, 2).join('.')
      : '';

    let label = tag + id + cls;
    if (target.tagName === 'IFRAME') label += '  ⏎ 点击进入';

    tooltipLabel.textContent = label;
    tooltipDims.textContent = Math.round(rect.width) + '×' + Math.round(rect.height);
    tooltipEl.style.display = 'flex';

    // Position tooltip near cursor, avoiding viewport edges
    let tx = e.clientX + 12;
    let ty = e.clientY - 30;
    if (tx + 320 > window.innerWidth) tx = e.clientX - 320;
    if (ty < 4) ty = e.clientY + 16;
    tooltipEl.style.left = tx + 'px';
    tooltipEl.style.top = ty + 'px';
  }

  // ── Event: click on overlay — resolve pick ──
  function onClick(e: MouseEvent) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!currentEl) return;

    // If clicking on an iframe, request iframe entry
    if (currentEl.tagName === 'IFRAME') {
      const iframes = Array.from(document.querySelectorAll('iframe'));
      chrome.runtime.sendMessage({
        type: 'cebian:picker-enter-iframe',
        iframeSrc: (currentEl as HTMLIFrameElement).src || '',
        iframeIndex: iframes.indexOf(currentEl as HTMLIFrameElement),
      });
      cleanupPicker();
      return;
    }

    // Compute element info and send result
    const r = currentEl.getBoundingClientRect();
    chrome.runtime.sendMessage({
      type: 'cebian:picker-result',
      selector: computeSelector(currentEl),
      tagName: currentEl.tagName.toLowerCase(),
      path: computePath(currentEl),
      attributes: collectAttributes(currentEl),
      textContent: ((currentEl as HTMLElement).innerText || '').slice(0, 200) || undefined,
      rect: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    });
    cleanupPicker();
  }

  // Block scroll and right-click context menu while picker is active.
  function onBlockEvent(e: Event) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // Defensive line: composed events (click/pointer/mouse/wheel/touch) still
  // traverse window capture even when dispatched inside our closed shadow root.
  // Stop them as soon as they touch any window-level capture listener IF the
  // event originated in our shadow tree — this prevents target-agnostic page
  // handlers (SPA router hijackers, analytics, etc.) from firing.
  function onWindowCapture(e: Event) {
    const path = e.composedPath();
    if (path.length > 0 && path.indexOf(host) !== -1) {
      e.stopImmediatePropagation();
    }
  }

  // ── Event: keydown — only intercept Escape ──
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      chrome.runtime.sendMessage({ type: 'cebian:picker-cancel' });
      cleanupPicker();
    }
  }

  // ── Cleanup ──
  function cleanupPicker() {
    // Delete the global hook first so any racing external cancel falls through
    // to its DOM-removal fallback instead of calling a half-dismantled picker.
    try { delete (window as any).__cebianPickerCleanup; } catch { /* non-configurable */ }
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('click', onWindowCapture, true);
    window.removeEventListener('pointerdown', onWindowCapture, true);
    window.removeEventListener('pointerup', onWindowCapture, true);
    window.removeEventListener('mousedown', onWindowCapture, true);
    window.removeEventListener('mouseup', onWindowCapture, true);
    window.removeEventListener('contextmenu', onWindowCapture, true);
    window.removeEventListener('wheel', onWindowCapture, true);
    window.removeEventListener('touchstart', onWindowCapture, true);
    window.removeEventListener('touchmove', onWindowCapture, true);
    try { cursorStyle.remove(); } catch { /* detached */ }
    try { host.remove(); } catch { /* detached */ }
  }

  // Overlay listeners handle the actual picker UX.
  overlay.addEventListener('pointermove', onPointerMove);
  overlay.addEventListener('click', onClick);
  overlay.addEventListener('contextmenu', onBlockEvent);
  overlay.addEventListener('wheel', onBlockEvent, { passive: false });
  overlay.addEventListener('touchmove', onBlockEvent, { passive: false });

  // Defensive window-capture listeners: stop composed events that originated
  // in our shadow tree before any page-registered window-capture handler runs.
  window.addEventListener('click', onWindowCapture, true);
  window.addEventListener('pointerdown', onWindowCapture, true);
  window.addEventListener('pointerup', onWindowCapture, true);
  window.addEventListener('mousedown', onWindowCapture, true);
  window.addEventListener('mouseup', onWindowCapture, true);
  window.addEventListener('contextmenu', onWindowCapture, true);
  window.addEventListener('wheel', onWindowCapture, true);
  window.addEventListener('touchstart', onWindowCapture, true);
  window.addEventListener('touchmove', onWindowCapture, true);

  // Keyboard events bypass hit-testing, so Escape must be registered on window.
  window.addEventListener('keydown', onKeyDown, true);

  // Expose cleanup so the extension side can tear down the picker on cancel
  // (e.g. user navigates tabs or calls startElementPicker again).
  (window as any).__cebianPickerCleanup = cleanupPicker;
}

// ─── Extension-side orchestration (runs in sidepanel) ───

let currentCleanup: (() => void) | null = null;

export async function startElementPicker(): Promise<ElementAttachment | null> {
  // Cancel any previous picker session
  if (currentCleanup) {
    currentCleanup();
    currentCleanup = null;
  }

  const tabId = await getActiveTabId();

  return new Promise<ElementAttachment | null>((resolve) => {
    function cleanup() {
      chrome.runtime.onMessage.removeListener(messageListener);
      chrome.tabs.onUpdated.removeListener(tabListener);
      currentCleanup = null;
    }

    // Handle page navigation while picker is active
    function tabListener(updatedTabId: number, info: { status?: string }) {
      if (updatedTabId === tabId && info.status === 'loading') {
        cleanup();
        resolve(null);
      }
    }

    function messageListener(msg: any, sender: chrome.runtime.MessageSender) {
      if (sender.tab?.id !== tabId) return;

      switch (msg.type) {
        case 'cebian:picker-result': {
          const frameId = sender.frameId ?? 0;
          cleanup();
          resolve({
            type: 'element',
            selector: msg.selector,
            tagName: msg.tagName,
            path: msg.path,
            attributes: msg.attributes,
            textContent: msg.textContent || undefined,
            rect: msg.rect,
            tabId: sender.tab?.id,
            tabUrl: sender.tab?.url,
            windowId: sender.tab?.windowId,
            frameId: frameId || undefined,
            frameUrl: frameId ? (sender.url || undefined) : undefined,
          });
          break;
        }

        case 'cebian:picker-cancel':
          cleanup();
          resolve(null);
          break;

        case 'cebian:picker-enter-iframe':
          enterIframe(tabId, msg, sender.frameId ?? 0).catch((err) => {
            console.warn('[Element Picker] Failed to enter iframe:', err);
          });
          break;
      }
    }

    // Setup: wire up cleanup so external callers can cancel
    currentCleanup = () => {
      cleanup();
      // Invoke the in-page cleanup hook in every frame so iframe pickers are
      // also torn down (the user may have entered an iframe before cancelling).
      // Fallback to removing the host/cursor directly in case the hook is
      // missing (e.g. previous session crashed before installing it).
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const w = window as any;
          if (typeof w.__cebianPickerCleanup === 'function') {
            w.__cebianPickerCleanup();
            return;
          }
          document.getElementById('cebian-picker-host')?.remove();
          document.getElementById('cebian-picker-cursor')?.remove();
        },
      }).catch(() => {});
      resolve(null);
    };

    chrome.runtime.onMessage.addListener(messageListener);
    chrome.tabs.onUpdated.addListener(tabListener);

    // Inject picker into the top frame
    chrome.scripting.executeScript({
      target: { tabId },
      func: createPickerInPage,
    }).catch((err) => {
      console.error('[Element Picker] Injection failed:', err);
      cleanup();
      resolve(null);
    });
  });
}

/** Inject picker into a child iframe. Sends cancel message on failure. */
async function enterIframe(tabId: number, msg: { iframeSrc: string; iframeIndex: number }, parentFrameId: number) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!frames) throw new Error('getAllFrames returned null');

    // Filter to direct children of the parent frame
    const children = frames.filter(f => f.parentFrameId === parentFrameId);

    let target: chrome.webNavigation.GetAllFrameResultDetails | undefined;

    // Match by URL first
    if (msg.iframeSrc) {
      const urlMatches = children.filter(f => f.url === msg.iframeSrc);
      target = urlMatches[0];
    }

    // Fallback: match by ordering index
    if (!target && msg.iframeIndex >= 0 && msg.iframeIndex < children.length) {
      target = children[msg.iframeIndex];
    }

    if (!target) throw new Error('Could not resolve iframe frameId');

    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [target.frameId] },
      func: createPickerInPage,
    });
  } catch (err) {
    console.warn('[Element Picker] iframe entry failed:', err);
    // Notify sidepanel listener so the promise resolves instead of hanging
    currentCleanup?.();
  }
}

/** Cancel the active picker session (if any). */
export function cancelElementPicker() {
  currentCleanup?.();
}

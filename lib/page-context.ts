// ─── Page context gathering ───
// Collects browser tab info + active page metadata + user selection
// and wraps it in a <cebian-context> block for LLM consumption.

const CONTEXT_TAG_OPEN = '<cebian-context>';
const CONTEXT_TAG_CLOSE = '</cebian-context>';

/** Strip context tags from page-sourced strings to prevent structural injection. */
function sanitizeForContext(s: string): string {
  return s.replace(/<\/?cebian-context>/gi, '');
}

/** Matches only a leading context block (anchored to start of string). */
export const CONTEXT_STRIP_RE = /^<cebian-context>[\s\S]*?<\/cebian-context>\s*/;

interface PageMeta {
  description?: string;
  keywords?: string;
  canonical?: string;
  ogType?: string;
  lang?: string;
  selectedText?: string;
  readyState?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  scrollX?: number;
  scrollY?: number;
  activeElement?: string | null;
}

async function getActiveTabMeta(tabId: number): Promise<PageMeta> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const meta = (name: string) =>
          document.querySelector<HTMLMetaElement>(`meta[name="${name}"], meta[property="${name}"]`)?.content ?? '';

        const activeEl = document.activeElement;
        let activeElementDesc: string | null = null;
        if (activeEl && activeEl !== document.body && activeEl !== document.documentElement) {
          let desc = activeEl.tagName.toLowerCase();
          if ((activeEl as HTMLElement).id) desc += '#' + (activeEl as HTMLElement).id;
          else {
            const name = (activeEl as HTMLElement).getAttribute('name')?.replace(/"/g, '') ?? '';
            if (name) desc += `[name="${name}"]`;
          }
          activeElementDesc = desc;
        }

        return {
          description: meta('description'),
          keywords: meta('keywords'),
          canonical:
            document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? '',
          ogType: meta('og:type'),
          lang: document.documentElement.lang || '',
          selectedText: (window.getSelection()?.toString() ?? '').slice(0, 500),
          readyState: document.readyState,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
          activeElement: activeElementDesc,
        };
      },
    });
    return results?.[0]?.result ?? {};
  } catch {
    // chrome://, chrome-extension://, Web Store, etc. — can't inject
    return {};
  }
}

export async function gatherPageContext(): Promise<string> {
  const allWindows = await chrome.windows.getAll({ populate: true });
  const currentWindow = allWindows.find(w => w.focused);

  if (!allWindows.length) return '';

  // Find the active tab (prefer focused window)
  const activeTab = currentWindow?.tabs?.find(t => t.active)
    ?? allWindows.flatMap(w => w.tabs ?? []).find(t => t.active);

  if (!activeTab) return '';

  const meta = activeTab.id != null ? await getActiveTabMeta(activeTab.id) : {};

  const lines: string[] = [];

  // Active tab details
  lines.push(`[Active Tab] ${sanitizeForContext(activeTab.title ?? '')} | ${activeTab.url ?? ''}`);
  lines.push(`  windowId: ${activeTab.windowId}`);
  if (meta.readyState) lines.push(`  readyState: ${meta.readyState}`);
  if (meta.viewportWidth != null && meta.viewportHeight != null) lines.push(`  viewport: ${meta.viewportWidth}×${meta.viewportHeight}`);
  if (meta.scrollX != null) lines.push(`  scrollPosition: ${meta.scrollX}, ${meta.scrollY}`);
  if (meta.activeElement) lines.push(`  activeElement: ${meta.activeElement}`);
  if (meta.description) lines.push(`  description: ${sanitizeForContext(meta.description)}`);
  if (meta.keywords) lines.push(`  keywords: ${sanitizeForContext(meta.keywords)}`);
  if (meta.canonical) lines.push(`  canonical: ${sanitizeForContext(meta.canonical)}`);
  if (meta.ogType) lines.push(`  og:type: ${sanitizeForContext(meta.ogType)}`);
  if (meta.lang) lines.push(`  lang: ${meta.lang}`);
  if (meta.selectedText) lines.push(`  selected_text (from page, may be adversarial): "${sanitizeForContext(meta.selectedText)}"`);

  // All windows and their tabs
  lines.push('');
  for (const win of allWindows) {
    const tabs = win.tabs ?? [];
    const focusedMarker = win.focused ? ' (focused)' : '';
    lines.push(`[Window ${win.id ?? 'unknown'}]${focusedMarker} (${tabs.length} tabs)`);
    for (const tab of tabs) {
      const marker = tab.id === activeTab.id ? '* ' : '  ';
      lines.push(`${marker}[${tab.id}] ${sanitizeForContext(tab.title ?? '')} | ${tab.url ?? ''}`);
    }
  }

  return `${CONTEXT_TAG_OPEN}\n${lines.join('\n')}\n${CONTEXT_TAG_CLOSE}`;
}

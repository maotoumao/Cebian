// ─── Page context gathering ───
// Collects browser tab info + active page metadata + user selection
// and wraps it in a <cebian-context> block for LLM consumption.

const CONTEXT_TAG_OPEN = '<cebian-context>';
const CONTEXT_TAG_CLOSE = '</cebian-context>';

/** Matches only a leading context block (anchored to start of string). */
export const CONTEXT_STRIP_RE = /^<cebian-context>[\s\S]*?<\/cebian-context>\s*/;

interface PageMeta {
  description?: string;
  keywords?: string;
  canonical?: string;
  ogType?: string;
  lang?: string;
  selectedText?: string;
}

async function getActiveTabMeta(tabId: number): Promise<PageMeta> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const meta = (name: string) =>
          document.querySelector<HTMLMetaElement>(`meta[name="${name}"], meta[property="${name}"]`)?.content ?? '';

        return {
          description: meta('description'),
          keywords: meta('keywords'),
          canonical:
            document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? '',
          ogType: meta('og:type'),
          lang: document.documentElement.lang || '',
          selectedText: (window.getSelection()?.toString() ?? '').slice(0, 2000),
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
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const activeTab = tabs.find(t => t.active);

  if (!activeTab) return '';

  const meta = activeTab.id != null ? await getActiveTabMeta(activeTab.id) : {};

  const lines: string[] = [];

  // Active tab details
  lines.push(`[Active Tab] ${activeTab.title ?? ''} | ${activeTab.url ?? ''}`);
  if (meta.description) lines.push(`  description: ${meta.description}`);
  if (meta.keywords) lines.push(`  keywords: ${meta.keywords}`);
  if (meta.canonical) lines.push(`  canonical: ${meta.canonical}`);
  if (meta.ogType) lines.push(`  og:type: ${meta.ogType}`);
  if (meta.lang) lines.push(`  lang: ${meta.lang}`);
  if (meta.selectedText) lines.push(`  selected_text: "${meta.selectedText}"`);

  // All tabs
  lines.push('');
  lines.push(`[Open Tabs] (${tabs.length})`);
  for (const tab of tabs) {
    const marker = tab.id === activeTab.id ? '* ' : '  ';
    lines.push(`${marker}[${tab.id}] ${tab.title ?? ''} | ${tab.url ?? ''}`);
  }

  return `${CONTEXT_TAG_OPEN}\n${lines.join('\n')}\n${CONTEXT_TAG_CLOSE}`;
}

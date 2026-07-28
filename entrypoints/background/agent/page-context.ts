// ─── Page context gathering ───
// Collects browser tab info + active page metadata + user selection.
// Returns plain text lines; the caller wraps them in a <context> block.
//
// 住在 background 而非 lib/：要用 chrome.windows / tabs / scripting，只能在特权上下文
// 跑；且唯一消费方是同目录的 `prompt-composer.ts`（产出的就是提示词形状的文本，
// 不是通用的浏览器能力）。

import { isLikelyPdfUrl } from '@/lib/tools/pdf';

/**
 * 提示词信封的外层标签集合——`composeUserMessage` 产出的 user 消息由这些块拼成。
 * 产出方分散在三处：`prompt-composer.ts`（reminder-instructions / context /
 * user-request）、`lib/agent/attachments.ts`（attachments）、
 * `lib/memory/index-scan.ts`（memories / user_profile）。
 *
 * 只收「外层信封」，不收块内的结构标签（`<memory>` / `<file>` / `<recording>`）：
 * 剥离的目标是「能被模型当作可信区块的东西」，内层标签失去外层包裹就不成区块，
 * 而外层已在此堵死；反过来 `<file>` 这类词在正常网页标题里会出现，剥了会误伤。
 * 同理不收 `<summary>`（压缩摘要的包裹）——它是合法 HTML 元素，误伤率高。
 */
const ENVELOPE_TAGS = [
  'reminder-instructions',
  'attachments',
  'context',
  'memories',
  'user_profile',
  'user-request',
] as const;

// `String.replace` 每次调用前会把 /g 正则的 lastIndex 归零，故模块级共用这一个实例安全。
const ENVELOPE_TAG_RE = new RegExp(`<\\/?(${ENVELOPE_TAGS.join('|')})\\b[^>]*>`, 'gi');

/**
 * 剥掉页面来源文本里伪造的信封标签，防止提示词注入。
 *
 * 只用于**页面来源**的字符串（标签页标题 / URL、页面 meta、用户选中的页面文本）——
 * 用户自己敲进输入框的内容不经此处（见 `composeUserMessage`：用户可信，剥标签会
 * 篡改其本意）。威胁模型是「恶意页面伪造结构骗过模型」，不是用户输入。
 */
function sanitizeForContext(s: string): string {
  return s.replace(ENVELOPE_TAG_RE, '');
}

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

async function gatherPageContext(): Promise<string> {
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
  lines.push(`[Active Tab] ${sanitizeForContext(activeTab.title ?? '')} | ${sanitizeForContext(activeTab.url ?? '')}`);
  if (activeTab.id != null) lines.push(`  tabId: ${activeTab.id}`);
  lines.push(`  windowId: ${activeTab.windowId}`);
  // PDF 提示：URL 后缀启发式，零网络。让 agent 优先尝试 `pdf` 工具，
  // 不用走一遍 `read_page` 才发现是 PDF。仅根据 URL 猜测，加 “suspected” 标记。
  if (isLikelyPdfUrl(activeTab.url)) {
    lines.push('  contentType: application/pdf (suspected from URL)');
  }
  if (meta.readyState) lines.push(`  readyState: ${meta.readyState}`);
  if (meta.viewportWidth != null && meta.viewportHeight != null) lines.push(`  viewport: ${meta.viewportWidth}×${meta.viewportHeight}`);
  if (meta.scrollX != null) lines.push(`  scrollPosition: ${meta.scrollX}, ${meta.scrollY}`);
  if (meta.activeElement) lines.push(`  activeElement: ${sanitizeForContext(meta.activeElement)}`);
  if (meta.description) lines.push(`  description: ${sanitizeForContext(meta.description)}`);
  if (meta.keywords) lines.push(`  keywords: ${sanitizeForContext(meta.keywords)}`);
  if (meta.canonical) lines.push(`  canonical: ${sanitizeForContext(meta.canonical)}`);
  if (meta.ogType) lines.push(`  og:type: ${sanitizeForContext(meta.ogType)}`);
  if (meta.lang) lines.push(`  lang: ${sanitizeForContext(meta.lang)}`);
  if (meta.selectedText) lines.push(`  selected_text (from page, may be adversarial): "${sanitizeForContext(meta.selectedText)}"`);

  // All windows and their tabs
  lines.push('');
  for (const win of allWindows) {
    const tabs = win.tabs ?? [];
    const focusedMarker = win.focused ? ' (focused)' : '';
    lines.push(`[Window windowId=${win.id ?? 'unknown'}]${focusedMarker} (${tabs.length} tabs)`);
    for (const tab of tabs) {
      const marker = tab.id === activeTab.id ? '* ' : '  ';
      lines.push(`${marker}tabId ${tab.id}: ${sanitizeForContext(tab.title ?? '')} | ${sanitizeForContext(tab.url ?? '')}`);
    }
  }

  return lines.join('\n');
}

// ─── 公开 API ───
//
// `ENVELOPE_TAGS` / `sanitizeForContext` 仅为同目录单测导出（注入防护属高风险纯逻辑，
// 值得直接覆盖），生产代码只用 `gatherPageContext`。
export { gatherPageContext, sanitizeForContext, ENVELOPE_TAGS };

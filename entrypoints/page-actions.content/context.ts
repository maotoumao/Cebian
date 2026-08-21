// 采集有界上下文（页面标题 + 选区周边文本），供翻译 / 解释 / 总结消歧用。内容脚本侧
// 逻辑（需要选区的 DOM 上下文）。刻意有界：控制 token、成本与隐私。

const MAX_CONTEXT = 800;
const SIDE_WINDOW = 350;

/**
 * 以「实际选区」为中心，从块级元素的渲染文本里截一个窗口。用 Range 求选区在块内的偏移
 * （而非 indexOf 找首次出现），故重复短语 / 表格单元格也定位准确。全程 try/catch，
 * 任何 DOM 异常都退回空串（采集上下文永不致命）。
 */
function windowAroundRange(block: Element, range: Range): string {
  try {
    const blockRange = document.createRange();
    blockRange.selectNodeContents(block);
    const full = blockRange.toString();
    if (!full) return '';

    const prefix = document.createRange();
    prefix.selectNodeContents(block);
    prefix.setEnd(range.startContainer, range.startOffset);
    const center = prefix.toString().length;
    const selLen = range.toString().length;

    const start = Math.max(0, center - SIDE_WINDOW);
    const end = Math.min(full.length, center + selLen + SIDE_WINDOW);
    const slice = full.slice(start, end).replace(/\s+/g, ' ').trim();
    return (start > 0 ? '…' : '') + slice + (end < full.length ? '…' : '');
  } catch {
    return '';
  }
}

/**
 * 采集有界上下文字符串：`Page title: …` + 选区所在块级元素的周边文本（以选区为中心
 * 截窗口）。输入框选区只带标题（其值本身即内容）。总长上限 {@link MAX_CONTEXT}。
 * 全程容错：任何 DOM 异常都退回仅标题，绝不影响动作点击。
 */
function gatherContext(): string {
  const title = (document.title ?? '').trim();

  let surrounding = '';
  try {
    const active = document.activeElement;
    const inField =
      active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
    if (!inField) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const node = range.commonAncestorContainer;
        const el = node instanceof Element ? node : node.parentElement;
        const block = el?.closest(
          'p,li,article,section,td,blockquote,h1,h2,h3,h4,h5,h6,div',
        );
        if (block) surrounding = windowAroundRange(block, range);
      }
    }
  } catch {
    surrounding = '';
  }

  const parts: string[] = [];
  if (title) parts.push(`Page title: ${title}`);
  if (surrounding) parts.push(surrounding);
  const joined = parts.join('\n');
  return joined.length > MAX_CONTEXT ? `${joined.slice(0, MAX_CONTEXT)}…` : joined;
}

/**
 * 页面侧能采集到的模板变量。其余环境常量（date / ui_language）由 background 补齐，
 * 内置动作只消费其中的 `context`。
 *
 * 在点击那一刻采集：此后选区可能变化、SPA 可能跳走，快照才对得上用户当时看到的内容。
 */
export function gatherPageVars(): Record<string, string> {
  return {
    context: gatherContext(),
    page_url: location.href,
    page_title: document.title ?? '',
  };
}

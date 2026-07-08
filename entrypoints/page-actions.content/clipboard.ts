// 内容脚本共用的剪贴板复制。刻意不复用 lib/ui/clipboard——它耦合了 sidepanel 的
// sonner toaster，内容脚本没挂 Toaster，导入还会把 toast 打进每个页面。反馈由各自
// 的 UI（工具条对勾 / 结果卡对勾）承担。

/**
 * 复制纯文本到剪贴板。优先 Clipboard API；失败回退隐藏 textarea + execCommand，并在
 * finally 无条件恢复原文档选区 / 输入框焦点与选区，避免 select() 抢走选区导致工具条 /
 * 结果卡消失。返回是否成功。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const activeEl = document.activeElement;
    const savedInput =
      activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement
        ? { el: activeEl, start: activeEl.selectionStart, end: activeEl.selectionEnd }
        : null;
    const sel = window.getSelection();
    const savedRange = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    try {
      ta.focus();
      ta.select();
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      ta.remove();
      if (savedRange && sel) {
        sel.removeAllRanges();
        sel.addRange(savedRange);
      }
      if (savedInput) {
        try {
          savedInput.el.focus();
          if (savedInput.start != null && savedInput.end != null) {
            savedInput.el.setSelectionRange(savedInput.start, savedInput.end);
          }
        } catch {
          // 输入框可能已从 DOM 移除，忽略
        }
      }
    }
  }
}

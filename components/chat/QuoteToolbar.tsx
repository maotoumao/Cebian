// 划词引用工具条（issue #103）：在对话区里选中一段文字时，浮在小工具条上点
// 「引用」把选中文本追加进输入框。内容脚本里的 SelectionToolbar 管的是页面
// 文本，这里只处理侧边栏自己的消息区。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Quote, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';

interface QuoteToolbarProps {
  /** 选区根节点（ScrollArea 的内容区）：只有选区落在它内才显示工具条。 */
  root: HTMLElement | null;
  /** 工具条定位的参考框（外层不随滚动位移的 wrapper）。坐标相对它。 */
  wrapper: HTMLElement | null;
  /** 点「引用」回调：传出选中后的纯文本。空选区不会回调。 */
  onQuote: (quote: string) => void;
}

interface Anchor {
  x: number;
  y: number;
  text: string;
}

/** 取选区在 wrapper 内的显示位置（相对 wrapper）。选区跨多行时取首行末端。 */
function readSelection(root: HTMLElement, wrapper: HTMLElement | null): Anchor | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  // 退格 / 零选区 / 选区落在根节点之外
  if (range.collapsed || !root.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  const box = wrapper ? wrapper.getBoundingClientRect() : root.getBoundingClientRect();
  return { x: rect.left - box.left + rect.width / 2, y: rect.top - box.top, text };
}

export function QuoteToolbar({ root, wrapper, onQuote }: QuoteToolbarProps) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const timer = useRef<number>(0);
  const dismiss = useCallback(() => setAnchor(null), []);

  // 选区在 root 内出现 / 变化时延迟 150ms 才显示工具条，避免拖选过程中工具条跟着鼠标跳动
  useEffect(() => {
    if (!root || !wrapper) return;
    const handle = () => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        setAnchor(readSelection(root, wrapper));
      }, 150);
    };
    const onMouseUp = () => {
      // mouseup 后选区即定，但 selectionchange 可能稍后才触发，两处都听一次
      handle();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    document.addEventListener('selectionchange', handle);
    root.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener('selectionchange', handle);
      root.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keydown', onKey);
    };
  }, [root, wrapper, dismiss]);

  // 滚轮 / 内容滚动会撕碎选区坐标——工具条直接收起，不追着飘
  useEffect(() => {
    if (!anchor || !wrapper) return;
    const viewport = wrapper.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
    if (!viewport) return;
    const onScroll = () => setAnchor(null);
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', onScroll);
  }, [anchor, wrapper]);

  if (!wrapper || !anchor) return null;

  const handleQuote = () => {
    onQuote(anchor.text);
    setAnchor(null);
  };

  // 锚点位置：选区末端上方居中，被 wrapper 裁掉时落回其内
  const toolbarW = 116;
  const left = Math.max(4, Math.min(anchor.x - toolbarW / 2, wrapper.clientWidth - toolbarW - 4));
  const top = Math.max(4, anchor.y - 40);

  return (
    <div
      className="absolute z-30 flex items-center gap-1 rounded-lg border border-border bg-popover shadow-xl px-1.5 py-1"
      style={{ left, top }}
      role="toolbar"
      aria-label={t('chat.composer.quote')}
      onMouseDown={(e) => e.preventDefault()}
    >
      <Button variant="ghost" size="icon-xs" className="size-6" onClick={handleQuote} title={t('chat.composer.quote')} aria-label={t('chat.composer.quote')}>
        <Quote className="size-3.5" />
      </Button>
      <Button variant="ghost" size="icon-xs" className="size-6" onClick={dismiss} title={t('chat.composer.quoteDismiss')} aria-label={t('chat.composer.quoteDismiss')}>
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

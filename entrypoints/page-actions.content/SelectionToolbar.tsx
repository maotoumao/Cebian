import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Copy, Check, Sparkles, Languages, ScrollText, Wand2, GripVertical } from 'lucide-react';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  pageActionsConfig,
  pageInteractionSettings,
  resolvePageActionsConfig,
  resolvePageInteractionSettings,
} from '@/lib/persistence/storage';
import { visibleToolbarActions } from '@/lib/page-actions/actions';
import type { PageActionId } from '@/lib/page-actions/types';
import { matchesAnyPagePattern } from '@/lib/page-actions/match';
import { t } from '@/lib/i18n';
import { copyText } from './clipboard';
import { gatherPageVars } from './context';
import { ResultCard } from './ResultCard';
import { useCurrentUrl } from './useCurrentUrl';

/** 选区锚点：选中的文本 + 其在视口中的包围盒。 */
interface SelectionAnchor {
  text: string;
  rect: DOMRect;
}

/** 工具条相对视口的固定位置。 */
interface Position {
  left: number;
  top: number;
}

const GAP = 8;
const SELECTION_DEBOUNCE_MS = 180;

// 复用一个离屏 canvas 量文本宽度（估算 <input> 内选区的像素位置）。
let measureCanvas: HTMLCanvasElement | null = null;

/**
 * 估算单行 <input> 内选区的矩形（视口坐标）：用 canvas 按输入框字体量出选区前文本与
 * 选中文本的宽度，推出选中字符的水平位置。<textarea> 多行定位成本高，退回整体包围盒。
 */
function getInputSelectionRect(
  el: HTMLInputElement | HTMLTextAreaElement,
  start: number,
  end: number,
): DOMRect {
  const rect = el.getBoundingClientRect();
  if (el instanceof HTMLTextAreaElement) return rect;
  const style = getComputedStyle(el);
  // 只支持常规 LTR / 左对齐 / 正常字距的单行输入；RTL / 居中右对齐 / letter-spacing
  // 精确定位成本高，退回整体包围盒。
  const align = style.textAlign;
  if (
    style.direction !== 'ltr' ||
    (align !== 'left' && align !== 'start') ||
    (style.letterSpacing !== 'normal' && parseFloat(style.letterSpacing) !== 0)
  ) {
    return rect;
  }
  const ctx = (measureCanvas ??= document.createElement('canvas')).getContext('2d');
  if (!ctx) return rect;
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const value = el.value;
  const startX = ctx.measureText(value.slice(0, start)).width;
  const selWidth = ctx.measureText(value.slice(start, end)).width;
  const padLeft = parseFloat(style.paddingLeft) || 0;
  const padRight = parseFloat(style.paddingRight) || 0;
  const borderLeft = parseFloat(style.borderLeftWidth) || 0;
  const borderRight = parseFloat(style.borderRightWidth) || 0;
  // 选区在视口的左 / 右边界（含水平滚动），再与输入框可见文本区求交，
  // 避免选区滚出可视范围时锚点飞出框外。
  const textLeft = rect.left + borderLeft + padLeft - el.scrollLeft;
  const visibleLeft = rect.left + borderLeft + padLeft;
  const visibleRight = rect.right - borderRight - padRight;
  const clampedLeft = Math.max(visibleLeft, Math.min(textLeft + startX, visibleRight));
  const clampedRight = Math.max(visibleLeft, Math.min(textLeft + startX + selWidth, visibleRight));
  return new DOMRect(clampedLeft, rect.top, Math.max(0, clampedRight - clampedLeft), rect.height);
}

/** 读取当前活动选区：优先 input/textarea 内选区，否则取文档选区。 */
function getActiveSelection(): SelectionAnchor | null {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const { selectionStart, selectionEnd } = active;
    if (selectionStart != null && selectionEnd != null && selectionEnd > selectionStart) {
      const text = active.value.slice(selectionStart, selectionEnd);
      if (text.trim()) {
        return { text, rect: getInputSelectionRect(active, selectionStart, selectionEnd) };
      }
    }
  }
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
    const text = sel.toString();
    if (text.trim()) {
      // 锚在选区末行（最后一个 client rect），多行选区时更贴合鼠标释放处。
      const range = sel.getRangeAt(0);
      const rects = range.getClientRects();
      const rect = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
      return { text, rect };
    }
  }
  return null;
}

/**
 * 监听文档选区变化，产出当前锚点（无选区时为 null）。selectionchange 做去抖，
 * mouseup / keyup 立即刷新；scroll / resize 时刷新锚点位置（选区仍在则更新 rect，
 * 消失则清空 → 隐藏）。
 */
function useSelectionAnchor(enabled: boolean): SelectionAnchor | null {
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null);
  // Escape 主动忽略的选区文本：直到选区文本变化前都不再弹出，避免 keyup /
  // selectionchange 立刻把同一选区重新显示出来。
  const dismissedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setAnchor(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 鼠标拖拽选择进行中：selectionchange 会连续触发，此时只隐藏、不显示，等 mouseup
    // 结算后再显示，避免拖选途中工具条乱跳（点 / 拖工具条本身已 preventDefault，不产生
    // 选区变化，故不受影响）。
    let pointerDown = false;
    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const show = () => {
      const next = getActiveSelection();
      // 被 Escape 忽略的同一选区不再弹出；选区文本变化即解除忽略。
      if (next && next.text === dismissedRef.current) {
        setAnchor(null);
        return;
      }
      dismissedRef.current = null;
      setAnchor(next);
    };
    const onSelectionChange = () => {
      clearTimer();
      if (pointerDown) {
        setAnchor(null);
        return;
      }
      timer = setTimeout(show, SELECTION_DEBOUNCE_MS);
    };
    const onMouseDown = () => {
      pointerDown = true;
    };
    const onMouseUp = () => {
      pointerDown = false;
      show();
    };
    // 鼠标在文档外释放 / 窗口失焦时兼底复位标志，避免 pointerDown 卡在 true。
    const onWindowBlur = () => {
      pointerDown = false;
    };
    const onScroll = () => setAnchor((prev) => (prev ? getActiveSelection() : prev));
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      clearTimer();
      dismissedRef.current = getActiveSelection()?.text ?? null;
      setAnchor(null);
    };

    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mousedown', onMouseDown, true);
    // mouseup 用捕获相（与 mousedown 一致）：document 捕获早于任何子元素，页面在子元素
    // 上 stopPropagation 也不会拦住它，确保 pointerDown 能被清。
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('keyup', show);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      clearTimer();
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('mouseup', onMouseUp, true);
      document.removeEventListener('keyup', show);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled]);

  return anchor;
}

// ─── 样式（内联，避免把 Tailwind 打进内容脚本；Shadow DOM 已隔离页面样式） ───

const barStyle: CSSProperties = {
  position: 'fixed',
  zIndex: 2147483647,
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'stretch',
  gap: 2,
  padding: 3,
  background: '#ffffff',
  border: '1px solid rgba(0, 0, 0, 0.08)',
  borderRadius: 10,
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.16)',
  color: '#1c1d25',
  font: "13px/1 system-ui, -apple-system, 'Segoe UI', sans-serif",
  userSelect: 'none',
};

const gripStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  paddingLeft: 2,
  paddingRight: 2,
  color: '#9aa0aa',
  cursor: 'grab',
  touchAction: 'none',
};

const btnStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  padding: '6px 9px',
  margin: 0,
  border: 'none',
  borderRadius: 7,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const dividerStyle: CSSProperties = {
  width: 1,
  alignSelf: 'stretch',
  margin: '3px 1px',
  background: 'rgba(0, 0, 0, 0.08)',
};

/** 工具条上的一个动作按钮（图标 + 文案，hover 变底色）。 */
function ToolButton({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      style={{ ...btnStyle, background: hover ? 'rgba(0, 0, 0, 0.06)' : 'transparent' }}
      title={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

/** 内置动作的图标（UI 关切，故留在内容脚本；自定义动作统一用魔杖图标）。 */
const BUILTIN_ICONS: Record<string, typeof Sparkles> = {
  explain: Sparkles,
  translate: Languages,
  summarize: ScrollText,
};

function actionIcon(id: string, size: number) {
  const Icon = Object.hasOwn(BUILTIN_ICONS, id) ? BUILTIN_ICONS[id] : Wand2;
  return <Icon size={size} />;
}

/**
 * SelectionToolbar — 划词工具条：选中文本时锚定在选区附近，提供复制 + 一组可配置动作
 * （内置解释 / 翻译 / 总结，加用户自定义动作），左侧把手可拖拽移动。
 * 受 `pageInteractionSettings`（总开关 + 隐藏页面）与 `pageActionsConfig`（动作启停 /
 * 改名 / 页面规则 / 排序）实时控制。点动作后展开内联结果卡（ResultCard）。
 */
export function SelectionToolbar() {
  const [stored] = useStorageItem(pageInteractionSettings, undefined);
  const [storedActions] = useStorageItem(pageActionsConfig, undefined);
  const settings = resolvePageInteractionSettings(stored);
  const url = useCurrentUrl();

  // 命中隐藏规则时连选区监听一起停掉（enabled=false 会清空锚点），不只是不渲染。
  const enabled =
    settings.showSelectionToolbar && !matchesAnyPagePattern(url, settings.toolbarHiddenPages);
  const actions = useMemo(
    () => visibleToolbarActions(resolvePageActionsConfig(storedActions), url),
    [storedActions, url],
  );
  const anchor = useSelectionAnchor(enabled);
  const barRef = useRef<HTMLDivElement>(null);
  const [computed, setComputed] = useState<Position | null>(null);
  const [dragPos, setDragPos] = useState<Position | null>(null);
  const [copied, setCopied] = useState(false);
  // 当前打开的结果卡（解释 / 翻译 / 总结）；非 null 时展示卡片、隐藏工具条。
  // text / context / rect 在点击时捕获，卡片独立于后续选区变化。
  const [action, setAction] = useState<{
    id: PageActionId;
    label: string;
    text: string;
    /** 点击那刻的页面侧模板变量（context / page_url / page_title）。 */
    vars: Record<string, string>;
    rect: DOMRect;
  } | null>(null);
  // 拖拽 / 复制反馈的清理句柄：组件卸载（含拖拽中途）时统一收尾，避免残留监听 / 定时器。
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      dragCleanupRef.current?.();
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    [],
  );

  // 新选区（文本变化）时重置拖拽位置，让工具条重新锚定选区。
  const selectionText = anchor?.text ?? null;
  useEffect(() => {
    setDragPos(null);
    setCopied(false);
  }, [selectionText]);

  // 锚定定位：测量工具条尺寸，居中于选区上方（放不下则移到下方），并夹在视口内。
  useLayoutEffect(() => {
    if (!anchor || !barRef.current) {
      setComputed(null);
      return;
    }
    const el = barRef.current;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cx = anchor.rect.left + anchor.rect.width / 2;
    const left = Math.max(GAP, Math.min(cx - w / 2, vw - w - GAP));
    let top = anchor.rect.top - h - GAP;
    if (top < GAP) top = Math.min(anchor.rect.bottom + GAP, vh - h - GAP);
    setComputed({ left, top });
  }, [anchor]);

  const startDrag = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault();
      const base = dragPos ?? computed;
      if (!base) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const el = e.currentTarget as HTMLElement;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // 某些环境下 setPointerCapture 可能抛（指针已释放），不影响 window 级拖拽监听
      }
      const onMove = (ev: PointerEvent) => {
        setDragPos({ left: base.left + (ev.clientX - startX), top: base.top + (ev.clientY - startY) });
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', cleanup);
        window.removeEventListener('pointercancel', cleanup);
        dragCleanupRef.current = null;
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', cleanup);
      window.addEventListener('pointercancel', cleanup);
      dragCleanupRef.current = cleanup;
    },
    [dragPos, computed],
  );

  const handleCopy = useCallback(() => {
    if (!anchor) return;
    void copyText(anchor.text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1400);
    });
  }, [anchor]);

  const startAction = useCallback(
    (id: PageActionId, label: string) => {
      if (!anchor) return;
      // 点击时选区仍在（onMouseDown preventDefault），此刻采集页面侧变量。
      setAction({ id, label, text: anchor.text, vars: gatherPageVars(), rect: anchor.rect });
    },
    [anchor],
  );

  // 结果卡打开时只展示卡片（隐藏工具条）；关闭后若选区仍在则工具条重现。
  if (action) {
    return (
      <ResultCard
        actionId={action.id}
        title={action.label}
        text={action.text}
        vars={action.vars}
        anchorRect={action.rect}
        onClose={() => setAction(null)}
      />
    );
  }

  if (!anchor) return null;

  const pos = dragPos ?? computed;
  const style: CSSProperties = {
    ...barStyle,
    left: pos?.left ?? 0,
    top: pos?.top ?? 0,
    // 首帧尚未测量出位置时先隐藏，避免闪到 (0,0)。
    visibility: pos ? 'visible' : 'hidden',
  };

  const iconSize = 15;

  return (
    <div
      ref={barRef}
      style={style}
      // 按下工具条不清空页面选区（保住已选文本给解释 / 翻译用）。
      onMouseDown={(e) => e.preventDefault()}
    >
      <div style={gripStyle} onPointerDown={startDrag} title="">
        <GripVertical size={15} />
      </div>
      <ToolButton
        icon={copied ? <Check size={iconSize} /> : <Copy size={iconSize} />}
        label={copied ? t('common.copied') : t('common.copy')}
        onClick={handleCopy}
      />
      <div style={dividerStyle} />
      {actions.map((a) => (
        <ToolButton
          key={a.id}
          icon={actionIcon(a.id, iconSize)}
          label={a.label}
          onClick={() => startAction(a.id, a.label)}
        />
      ))}
    </div>
  );
}

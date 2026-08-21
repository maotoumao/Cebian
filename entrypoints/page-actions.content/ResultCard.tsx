import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Copy, Check, Loader2, X, PanelRight } from 'lucide-react';
import { runPageAction, continueInSidePanel } from '@/lib/page-actions/channel';
import type { PageActionId } from '@/lib/page-actions/types';
import { t } from '@/lib/i18n';
import { copyText } from './clipboard';

const GAP = 8;
const CARD_WIDTH = 360;

type Status = 'streaming' | 'done' | 'error';

interface Position {
  left: number;
  top: number;
}

const cardStyle: CSSProperties = {
  position: 'fixed',
  zIndex: 2147483647,
  pointerEvents: 'auto',
  width: CARD_WIDTH,
  maxWidth: 'calc(100vw - 16px)',
  maxHeight: 'calc(100vh - 16px)',
  display: 'flex',
  flexDirection: 'column',
  background: '#ffffff',
  border: '1px solid rgba(0, 0, 0, 0.08)',
  borderRadius: 12,
  boxShadow: '0 8px 28px rgba(0, 0, 0, 0.2)',
  color: '#1c1d25',
  font: "13px/1.55 system-ui, -apple-system, 'Segoe UI', sans-serif",
  overflow: 'hidden',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 10px',
  borderBottom: '1px solid rgba(0, 0, 0, 0.06)',
  fontSize: 12,
  fontWeight: 600,
  color: '#3a3d47',
  cursor: 'move',
  userSelect: 'none',
  touchAction: 'none',
};

const bodyStyle: CSSProperties = {
  padding: '10px 12px',
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

// 后处理结果整段替换原文时的淡入（keyframes 在内容脚本的 Shadow DOM 样式里声明）。
const fadeInStyle: CSSProperties = {
  animation: 'cebian-fade-in 0.18s ease-out',
};

// 后处理失败的提示：展示已降级为原始输出，这行只说明「脚本没跑成」。
const transformErrorStyle: CSSProperties = {
  marginTop: 8,
  paddingTop: 6,
  borderTop: '1px solid rgba(0, 0, 0, 0.06)',
  color: '#8a8d9b',
  fontSize: 11,
};

const footerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: 6,
  borderTop: '1px solid rgba(0, 0, 0, 0.06)',
};

const iconBtnStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 5,
  padding: '5px 8px',
  border: 'none',
  borderRadius: 7,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
};

function HeaderIcon({ status }: { status: Status }) {
  if (status === 'streaming') {
    return <Loader2 size={14} style={{ animation: 'cebian-spin 1s linear infinite' }} />;
  }
  return null;
}

interface ResultCardProps {
  actionId: PageActionId;
  /** 卡片标题：发起方已解析好的动作显示名（内置跟随界面语言，自定义为用户起的名）。 */
  title: string;
  text: string;
  /** 点击那刻采集的页面侧模板变量（context / page_url / page_title）。 */
  vars: Record<string, string>;
  /** 触发时选区的视口矩形，用于锚定卡片。 */
  anchorRect: DOMRect;
  onClose: () => void;
}

/**
 * ResultCard — 划词工具条的内联结果卡：对选中文本执行一个划词动作，流式显示结果。
 * 以纯文本（pre-wrap）呈现（内容脚本无法加载非 web_accessible 的动态 chunk，故不在
 * 页内渲染 markdown；富文本交给「在侧边栏继续」）。「短暂调用」：动作本身不落库、
 * 历史查不到；只有点「在侧边栏继续」才把本次交互固化成会话。
 */
export function ResultCard({ actionId, title, text, vars, anchorRect, onClose }: ResultCardProps) {
  const [content, setContent] = useState('');
  // 后处理脚本的产物：非 null 即替换展示与复制内容（原始输出仍用于「在侧边栏继续」，
  // 那是模型真正说过的话，固化成历史才不会错位）。
  const [transformed, setTransformed] = useState<string | null>(null);
  const [transformFailed, setTransformFailed] = useState(false);
  const [status, setStatus] = useState<Status>('streaming');
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  // placement：按选区算一次的锚定位（top=向下生长 / bottom=向上生长）；dragPos：拖拽后
  // 的手动固定位（覆盖 placement）。分开使得流式增高时卡片不跳、拖过之后不再被重定位。
  const [placement, setPlacement] = useState<
    { left: number; top: number } | { left: number; bottom: number } | null
  >(null);
  const [dragPos, setDragPos] = useState<Position | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  // 发起流式动作；卸载即取消（断端口 → background abort）。
  useEffect(() => {
    let acc = '';
    const cancel = runPageAction(
      { actionId, text, params: vars },
      {
        onDelta: (delta) => {
          acc += delta;
          setContent(acc);
        },
        onDone: ({ transformed: out, transformError }) => {
          if (out !== undefined) setTransformed(out);
          if (transformError !== undefined) setTransformFailed(true);
          setStatus('done');
        },
        onError: () => setStatus((s) => (s === 'streaming' ? 'error' : s)),
      },
    );
    return () => {
      cancel();
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, [actionId, text, vars]);

  // 点击卡片外部关闭。卡片在 Shadow DOM 里，document 层的 event.target 会被重定向成
  // shadow host，无法区分内外；用 composedPath()（穿透 shadow、含真实点击节点）判断。
  // 空依赖 + ref 读最新 onClose，保持监听稳定；打开卡片那次点击早于本 effect 注册，不误触。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onDown = (e: Event) => {
      const el = cardRef.current;
      if (el && !e.composedPath().includes(el)) onCloseRef.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, []);

  // 按选区算一次锚定位（仅依赖 anchorRect，不随 content / status 重算）：空间够就放下方
  // （top 固定、向下生长），否则放上方并锚底边（bottom 固定、向上生长）——流式增高不跳。
  useLayoutEffect(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(CARD_WIDTH, vw - 2 * GAP);
    const cx = anchorRect.left + anchorRect.width / 2;
    const left = Math.max(GAP, Math.min(cx - w / 2, vw - w - GAP));
    const spaceBelow = vh - anchorRect.bottom - GAP;
    const spaceAbove = anchorRect.top - GAP;
    if (spaceBelow >= spaceAbove) {
      setPlacement({ left, top: anchorRect.bottom + GAP });
    } else {
      setPlacement({ left, bottom: vh - anchorRect.top + GAP });
    }
  }, [anchorRect]);

  // 展示与复制都用后处理后的文本（没配脚本或脚本失败时就是原始输出）。
  const shown = transformed ?? content;
  // 「有没有可见内容」要单独判断：后处理脚本合法地返回空串时，状态已是 done，
  // 若沿用 truthy 判断正文会一直显示「思考中」、页脚也不出现。
  const hasContent = shown.trim().length > 0;

  const handleCopy = () => {
    void copyText(shown).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1400);
    });
  };

  // 拖拽标题栏移动卡片（自由定位，夹在视口内）。卡片短暂，位置不持久。
  const startDrag = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const card = cardRef.current;
    if (!card) return;
    e.preventDefault();
    dragCleanupRef.current?.();
    const pointerId = e.pointerId;
    const rect = card.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(pointerId);
    } catch {
      // setPointerCapture 可能抛，不影响 window 级拖拽监听
    }
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const left = Math.max(GAP, Math.min(ev.clientX - offsetX, vw - w - GAP));
      const top = Math.max(GAP, Math.min(ev.clientY - offsetY, vh - h - GAP));
      setDragPos({ left, top });
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      dragCleanupRef.current = null;
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    dragCleanupRef.current = cleanup;
  };

  const anchored = dragPos ?? placement;
  // 根据锚定边算可用高度上限，使卡片在长结果下先滚动而不至于长出视口。
  const vh = window.innerHeight;
  const anchorMaxHeight = dragPos
    ? vh - dragPos.top - GAP
    : placement
      ? 'top' in placement
        ? vh - placement.top - GAP
        : vh - placement.bottom - GAP
      : vh - 2 * GAP;
  const style: CSSProperties = {
    ...cardStyle,
    maxHeight: Math.max(140, anchorMaxHeight),
    // 首帧尚未算出位置时先隐藏，避免闪到 (0,0)。
    visibility: anchored ? 'visible' : 'hidden',
    ...(dragPos
      ? { left: dragPos.left, top: dragPos.top }
      : placement
        ? 'top' in placement
          ? { left: placement.left, top: placement.top }
          : { left: placement.left, bottom: placement.bottom }
        : {}),
  };

  return (
    <div ref={cardRef} style={style}>
      <div style={headerStyle} onPointerDown={startDrag}>
        <HeaderIcon status={status} />
        <span>{title}</span>
        <button
          type="button"
          style={{ ...iconBtnStyle, marginLeft: 'auto', padding: 4 }}
          title={t('pageActions.result.close')}
          aria-label={t('pageActions.result.close')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </div>

      <div style={bodyStyle}>
        {status === 'error' ? (
          <span style={{ color: '#b4432f' }}>{t('pageActions.result.error')}</span>
        ) : hasContent ? (
          <span
            // 后处理结果是在流式结束后整段换掉的，淡入一下让这次跳变不突兀。
            key={transformed !== null ? 'transformed' : 'raw'}
            style={transformed !== null ? fadeInStyle : undefined}
          >
            {shown}
          </span>
        ) : status === 'streaming' ? (
          <span style={{ color: '#8a8d9b' }}>{t('pageActions.result.loading')}</span>
        ) : (
          <span style={{ color: '#8a8d9b' }}>{t('pageActions.result.empty')}</span>
        )}
        {transformFailed && (
          <div style={transformErrorStyle}>{t('pageActions.result.transformFailed')}</div>
        )}
      </div>

      {status === 'done' && hasContent && (
        <div style={footerStyle}>
          <button type="button" style={iconBtnStyle} onClick={handleCopy}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? t('common.copied') : t('common.copy')}
          </button>
          <button
            type="button"
            style={iconBtnStyle}
            onClick={() => {
              continueInSidePanel(actionId, text, content);
              onClose();
            }}
          >
            <PanelRight size={14} />
            {t('pageActions.result.continue')}
          </button>
        </div>
      )}
    </div>
  );
}

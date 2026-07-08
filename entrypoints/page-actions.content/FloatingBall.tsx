import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { browser } from 'wxt/browser';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  pageInteractionSettings,
  resolvePageInteractionSettings,
  floatingBallPosition,
  DEFAULT_FLOATING_BALL_POSITION,
} from '@/lib/persistence/storage';
import { toggleSidePanel } from '@/lib/page-actions/channel';
import { t } from '@/lib/i18n';

const ICON_URL = browser.runtime.getURL('/icon/128.png');
const BALL = 40;
// 小于此像素位移视为点击（照常 toggle 侧边栏），超过才算拖拽。
const DRAG_THRESHOLD = 4;

const baseBallStyle: CSSProperties = {
  position: 'fixed',
  zIndex: 2147483646,
  pointerEvents: 'auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: BALL,
  height: BALL,
  margin: 0,
  padding: 0,
  border: 'none',
  background: '#ffffff',
  boxShadow: '0 2px 10px rgba(0, 0, 0, 0.18)',
  touchAction: 'none',
  transition: 'opacity 0.15s ease',
};

const imgStyle: CSSProperties = {
  width: 24,
  height: 24,
  display: 'block',
  pointerEvents: 'none',
};

/**
 * 悬浮球按钮本体。抽成独立组件，只在 showFloatingBall 为真时挂载——这样开关切到关闭
 * 时它会卸载，卸载 effect 保证拖拽途中残留的 window 监听被清理。
 * - 点击（位移小于阈值）或键盘 / 辅助技术激活 → toggle 侧边栏
 * - 拖拽自由移动，松手吸附到最近的左 / 右边缘，记住侧别与垂直比例（跨页面持久）
 */
function BallButton() {
  const [pos, setPos] = useStorageItem(floatingBallPosition, DEFAULT_FLOATING_BALL_POSITION);
  const [hovered, setHovered] = useState(false);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const onPointerDown = (e: ReactPointerEvent) => {
    // 仅主键（左键 / 主触点）
    if (e.button !== 0) return;
    e.preventDefault();
    // 清掉可能残留的上一次拖拽
    dragCleanupRef.current?.();
    const pointerId = e.pointerId;
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // setPointerCapture 可能抛（指针已释放），不影响 window 级拖拽监听
    }
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > DRAG_THRESHOLD) {
        moved = true;
      }
      if (moved) setDrag({ x: ev.clientX - offsetX, y: ev.clientY - offsetY });
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      dragCleanupRef.current = null;
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
      setDrag(null);
      if (!moved) {
        toggleSidePanel();
        return;
      }
      // 松手：吸附到最近的左 / 右边缘，垂直位置存成比例。
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const centerX = ev.clientX - offsetX + BALL / 2;
      const centerY = ev.clientY - offsetY + BALL / 2;
      const side = centerX < vw / 2 ? 'left' : 'right';
      const topRatio = Math.min(0.96, Math.max(0.02, centerY / vh));
      void setPos({ side, topRatio });
    };
    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      // 取消：只收尾，不 toggle、不持久化（坐标可能失效）。
      cleanup();
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    dragCleanupRef.current = cleanup;
  };

  // 键盘 / 辅助技术激活：合成 click 的 detail 为 0（鼠标点击 detail >= 1，已由 onUp 处理）。
  const onClick = (e: ReactMouseEvent) => {
    if (e.detail === 0) toggleSidePanel();
  };

  const tooltip = t('pageActions.ball.tooltip');
  const dockedTop = `calc(${pos.topRatio * 100}% - ${BALL / 2}px)`;
  const style: CSSProperties = {
    ...baseBallStyle,
    opacity: drag || hovered ? 1 : 0.6,
    cursor: drag ? 'grabbing' : 'pointer',
    borderRadius: drag ? '50%' : pos.side === 'right' ? '50% 0 0 50%' : '0 50% 50% 0',
    ...(drag
      ? { left: drag.x, top: drag.y, right: 'auto' }
      : pos.side === 'right'
        ? { right: 0, left: 'auto', top: dockedTop }
        : { left: 0, right: 'auto', top: dockedTop }),
  };

  return (
    <button
      type="button"
      style={style}
      title={tooltip}
      aria-label={tooltip}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <img src={ICON_URL} alt="" style={imgStyle} draggable={false} />
    </button>
  );
}

/**
 * FloatingBall — 页面右 / 左侧的悬浮球，内容为扩展图标。
 * 受 `pageInteractionSettings.showFloatingBall` 实时控制：关闭时不挂载按钮（连同其拖拽
 * 监听一并卸载）。
 */
export function FloatingBall() {
  const [stored] = useStorageItem(pageInteractionSettings, undefined);
  const settings = resolvePageInteractionSettings(stored);
  if (!settings.showFloatingBall) return null;
  return <BallButton />;
}

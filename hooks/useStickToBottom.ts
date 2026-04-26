import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useStickToBottom — keep a Radix ScrollArea pinned to the bottom while
 * content grows (e.g. streaming chat messages), but stop following as soon
 * as the user scrolls up. Resumes following when the user scrolls back near
 * the bottom.
 *
 * Design notes:
 * - Truth source is `stickRef` (boolean), updated only by user-driven scroll
 *   events. A short time-window guard (`PROGRAMMATIC_GUARD_MS`) ignores the
 *   scroll events that our own programmatic `scrollTop = scrollHeight` writes
 *   trigger, so we never flip the state by accident.
 * - Auto-scroll is driven by a `ResizeObserver` on the viewport's content
 *   wrapper, which covers every height change source (streaming chunks,
 *   tool-card expansion, image load, markdown re-render) without relying
 *   on the chat's `messages` array identity.
 * - If the user is mid-drag on the scrollbar thumb, auto-scroll is skipped
 *   so the thumb does not get yanked away under their cursor.
 *
 * Usage:
 *   const { scrollRef, isAtBottom, scrollToBottom } = useStickToBottom();
 *   <ScrollArea ref={scrollRef}>...</ScrollArea>
 *   // Force pin (e.g. on session change, on send, on jump-button click):
 *   scrollToBottom({ force: true });
 */

const BOTTOM_THRESHOLD_PX = 32;
const PROGRAMMATIC_GUARD_MS = 80;

function getViewport(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  return root.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement | null;
}

function isAtBottomNow(viewport: HTMLElement): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM_THRESHOLD_PX;
}

export function useStickToBottom() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const isDraggingRef = useRef(false);
  const releaseDragRef = useRef<(() => void) | null>(null);
  const lastProgrammaticAtRef = useRef(0);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const scrollToBottom = useCallback((opts?: { force?: boolean }) => {
    const viewport = getViewport(scrollRef.current);
    if (!viewport) return;
    if (opts?.force) {
      if (!stickRef.current) {
        stickRef.current = true;
        setIsAtBottom(true);
      }
    } else if (!stickRef.current) {
      return;
    }
    lastProgrammaticAtRef.current = Date.now();
    viewport.scrollTop = viewport.scrollHeight;
  }, []);

  useEffect(() => {
    const root = scrollRef.current;
    const viewport = getViewport(root);
    if (!root || !viewport) return;

    // The viewport's first child is the inner content wrapper Radix renders.
    const contentEl = viewport.firstElementChild as HTMLElement | null;

    const onScroll = () => {
      // Ignore scroll events caused by our own programmatic writes.
      if (Date.now() - lastProgrammaticAtRef.current < PROGRAMMATIC_GUARD_MS) return;
      const atBottom = isAtBottomNow(viewport);
      if (stickRef.current !== atBottom) {
        stickRef.current = atBottom;
        setIsAtBottom(atBottom);
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (
        !target.closest(
          '[data-slot="scroll-area-scrollbar"], [data-slot="scroll-area-thumb"]',
        )
      ) {
        return;
      }
      // Clear any prior drag tracking (defensive — should not normally happen).
      releaseDragRef.current?.();
      isDraggingRef.current = true;
      const release = () => {
        isDraggingRef.current = false;
        window.removeEventListener('pointerup', release);
        window.removeEventListener('pointercancel', release);
        if (releaseDragRef.current === release) releaseDragRef.current = null;
      };
      releaseDragRef.current = release;
      window.addEventListener('pointerup', release);
      window.addEventListener('pointercancel', release);
    };

    let ro: ResizeObserver | null = null;
    if (contentEl) {
      ro = new ResizeObserver(() => {
        if (!stickRef.current) return;
        if (isDraggingRef.current) return;
        lastProgrammaticAtRef.current = Date.now();
        viewport.scrollTop = viewport.scrollHeight;
      });
      ro.observe(contentEl);
    }

    viewport.addEventListener('scroll', onScroll, { passive: true });
    root.addEventListener('pointerdown', onPointerDown, true);

    // Correct the initial state in case content already overflows on mount.
    const initiallyAtBottom = isAtBottomNow(viewport);
    if (!initiallyAtBottom) {
      stickRef.current = false;
      setIsAtBottom(false);
    }

    return () => {
      viewport.removeEventListener('scroll', onScroll);
      root.removeEventListener('pointerdown', onPointerDown, true);
      ro?.disconnect();
      releaseDragRef.current?.();
    };
  }, []);

  return { scrollRef, isAtBottom, scrollToBottom };
}

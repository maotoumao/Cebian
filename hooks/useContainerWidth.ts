import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * useContainerWidth — observe an element's content-box width via ResizeObserver.
 *
 * Returns `null` until the element is mounted and measured at least once.
 * Uses `useLayoutEffect` so the first measurement runs before paint, avoiding
 * a layout flash when the consumer switches layout at a breakpoint.
 *
 * Useful for component-level responsive layouts where `window.innerWidth`
 * is the wrong signal (e.g. the Settings hub renders both inside a ~380px
 * sidepanel and inside a full-width tab page).
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Seed with current size so first render after mount already has a value.
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return width;
}

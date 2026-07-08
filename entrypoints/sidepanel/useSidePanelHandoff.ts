import { useEffect } from 'react';
import { browser } from 'wxt/browser';
import { pendingSidePanelHandoff } from '@/lib/persistence/storage';

/**
 * 消费「在侧边栏继续」交接标记：background 固化会话后写入 `{ sessionId, windowId }`；
 * 仅当 windowId 命中本窗口时跳转到该会话并清空（多窗口时其它面板不误跳、不误清）。
 *
 * 面板可能刚被打开（写标记可能晚于挂载），故既在拿到 windowId 时读一次，也 watch 后续
 * 写入。仅侧边栏 entrypoint 使用。
 */
export function useSidePanelHandoff(onSession: (sessionId: string) => void): void {
  useEffect(() => {
    let windowId: number | null = null;
    let cancelled = false;

    const consume = async () => {
      if (windowId == null) return;
      const handoff = await pendingSidePanelHandoff.getValue();
      if (handoff && handoff.windowId === windowId) {
        // 命中本窗口：先清空再跳转（清空只由命中窗口做，避免跨窗口互相擦除）。
        await pendingSidePanelHandoff.setValue(null);
        if (!cancelled) onSession(handoff.sessionId);
      }
    };

    void browser.windows.getCurrent().then((win) => {
      if (cancelled || typeof win.id !== 'number') return;
      windowId = win.id;
      void consume();
    });

    const unwatch = pendingSidePanelHandoff.watch(() => {
      void consume();
    });

    return () => {
      cancelled = true;
      unwatch();
    };
  }, [onSession]);
}

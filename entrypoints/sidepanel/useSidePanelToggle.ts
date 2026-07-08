import { useEffect } from 'react';
import { browser } from 'wxt/browser';
import {
  reportSidePanelPresent,
  reportSidePanelGone,
  subscribeCloseSidePanel,
} from '@/lib/page-actions/channel';

/**
 * 让侧边栏参与悬浮球的 open/close toggle：
 * - 挂载时解析自身 windowId，向 background 上报「已打开」，并订阅「自关」指令
 *   （Chrome 无 sidePanel.close API，只能由面板自身 window.close()）
 * - 卸载 / pagehide 时上报「即将关闭」，让 background 同步开启态
 *
 * 仅侧边栏 entrypoint 使用，故住在 entrypoints/sidepanel/。
 */
export function useSidePanelToggle(): void {
  useEffect(() => {
    let windowId: number | null = null;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    void browser.windows.getCurrent().then((win) => {
      if (cancelled || typeof win.id !== 'number') return;
      const id = win.id;
      windowId = id;
      reportSidePanelPresent(id);
      unsubscribe = subscribeCloseSidePanel(id, () => {
        // 关闭前先上报，确保 background 开启态被权威清除（不依赖 pagehide 是否触发）。
        reportSidePanelGone(id);
        window.close();
      });
    });

    const onHide = () => {
      if (windowId != null) reportSidePanelGone(windowId);
    };
    window.addEventListener('pagehide', onHide);

    return () => {
      cancelled = true;
      window.removeEventListener('pagehide', onHide);
      unsubscribe?.();
      if (windowId != null) reportSidePanelGone(windowId);
    };
  }, []);
}

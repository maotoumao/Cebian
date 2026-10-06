import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { getActiveTabId } from '@/lib/browser/tab-actions';
import { isMobileEmulationSupported, toggleMobileEmulation } from '@/lib/browser/mobile-emulation';
import { mobileEmulatedTabs } from '@/lib/persistence/storage';
import { useStorageItem } from '@/hooks/useStorageItem';

/**
 * 手机模拟按钮的状态与切换。调试连接由后台持有，开启中的标签页从 `mobileEmulatedTabs`
 * 读取（后台在开关、连接被断开时更新），这里只跟踪本窗口当前的活动标签页。
 */
export function useMobileEmulation() {
  const supported = isMobileEmulationSupported();
  const [mobileTabs] = useStorageItem(mobileEmulatedTabs, []);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);

  useEffect(() => {
    const refresh = () => {
      getActiveTabId().then(setActiveTabId).catch(() => setActiveTabId(null));
    };
    refresh();
    chrome.tabs.onActivated.addListener(refresh);
    return () => chrome.tabs.onActivated.removeListener(refresh);
  }, []);

  const toggle = useCallback(async () => {
    try {
      await toggleMobileEmulation(await getActiveTabId());
    } catch (err) {
      toast.error(t('errors.mobile.toggleFailed'));
      console.error('[Mobile Emulation]', err);
    }
  }, []);

  const isActiveTabMobile = activeTabId != null && mobileTabs.includes(activeTabId);
  return { supported, isActiveTabMobile, toggle };
}

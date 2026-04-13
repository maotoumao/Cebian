import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { getActiveTabId } from '@/lib/tools/chrome-api';
import { attachEmulation, detachEmulation } from '@/lib/mobile-emulation';

export function useMobileEmulation() {
  const mobileTabsRef = useRef(new Set<number>());
  const [isActiveTabMobile, setIsActiveTabMobile] = useState(false);

  // Reconstruct state on mount (sidepanel reopen)
  useEffect(() => {
    chrome.debugger.getTargets((targets) => {
      const attachedTabIds = targets
        .filter((t) => t.attached && t.tabId != null)
        .map((t) => t.tabId!);
      for (const id of attachedTabIds) mobileTabsRef.current.add(id);
      getActiveTabId().then((activeId) => {
        setIsActiveTabMobile(mobileTabsRef.current.has(activeId));
      }).catch(() => {});
    });
  }, []);

  // Sync button state when active tab changes; clean up on tab close
  useEffect(() => {
    const onActivated = (activeInfo: { tabId: number }) => {
      setIsActiveTabMobile(mobileTabsRef.current.has(activeInfo.tabId));
    };
    const onRemoved = (tabId: number) => {
      mobileTabsRef.current.delete(tabId);
    };
    // Handle debugger detach by user (e.g. clicking "Cancel" on the debug banner)
    const onDetach = (source: chrome.debugger.Debuggee) => {
      if (source.tabId != null) {
        mobileTabsRef.current.delete(source.tabId);
        // Update button if detached tab is the active one
        getActiveTabId().then((activeId) => {
          if (activeId === source.tabId) setIsActiveTabMobile(false);
        }).catch(() => {});
      }
    };

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.debugger.onDetach.addListener(onDetach);

    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.debugger.onDetach.removeListener(onDetach);
    };
  }, []);

  const toggle = useCallback(async () => {
    try {
      const tabId = await getActiveTabId();
      if (mobileTabsRef.current.has(tabId)) {
        await detachEmulation(tabId);
        mobileTabsRef.current.delete(tabId);
        setIsActiveTabMobile(false);
      } else {
        await attachEmulation(tabId);
        mobileTabsRef.current.add(tabId);
        setIsActiveTabMobile(true);
      }
    } catch (err) {
      toast.error('移动端模式切换失败');
      console.error('[Mobile Emulation]', err);
    }
  }, []);

  return { isActiveTabMobile, toggle };
}

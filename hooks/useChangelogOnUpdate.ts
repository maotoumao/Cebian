/**
 * useChangelogOnUpdate — 侧边栏打开后，若后台在扩展升级时留下了「待展示更新日志」
 * 标记，则打开对应版本的更新日志页并清空标记。
 *
 * 配合 `entrypoints/background/lifecycle/update-notice.ts` 的 `onInstalled` 写入：背景
 * 只记录版本号，不主动开标签，保证标签只在用户主动打开侧边栏后才出现（绝不无授意弹页）。
 * 每次 mount 只消费一次；读取到版本后立刻清空，避免重复打开。
 */
import { useEffect, useRef } from 'react';
import { pendingChangelogVersion } from '@/lib/persistence/storage';
import { getChangelogUrl } from '@/lib/site-links';

export function useChangelogOnUpdate(): void {
  const consumedRef = useRef(false);

  useEffect(() => {
    if (consumedRef.current) return;
    consumedRef.current = true;

    void (async () => {
      try {
        const version = await pendingChangelogVersion.getValue();
        if (!version) return;
        // 先清空再开页：即使开页失败也不会下次重复弹，避免反复打扰。
        await pendingChangelogVersion.setValue(null);
        await chrome.tabs.create({ url: getChangelogUrl(version), active: true });
      } catch (err) {
        console.warn('[useChangelogOnUpdate] failed to open changelog:', err);
      }
    })();
  }, []);
}

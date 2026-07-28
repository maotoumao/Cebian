// 扩展升级后的更新日志提醒。
//
// 只记下新版本号，供侧边栏下次打开时弹出更新日志——不在此直接开标签，避免商店版
// 后台静默更新时在用户未授意下弹页。消费端见 hooks/useChangelogOnUpdate.ts。

import { pendingChangelogVersion } from '@/lib/persistence/storage';

/** 注册 onInstalled 监听：升级到新版本时记录版本号。在 background 入口调用一次。 */
export function setupUpdateNotice(): void {
  chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
    if (reason !== 'update') return;
    const current = chrome.runtime.getManifest().version;
    // `previousVersion` 等于当前版时跳过，挡掉 dev 热重载触发的同版本 onInstalled。
    if (previousVersion === current) return;
    void pendingChangelogVersion.setValue(current).catch((err) =>
      console.warn('[update-notice] failed to record changelog version:', err),
    );
  });
}

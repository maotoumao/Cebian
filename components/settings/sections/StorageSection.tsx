/**
 * StorageSection — 虚拟文件系统（VFS）的存储概览。
 *
 * 只读视角：显示 VFS 已用空间，并提供一个按钮在新标签打开文件浏览器
 * （落到 `/workspaces`，即按会话标题翻译后的文档列表）。VFS 浏览器本身是只读的，
 * 这里刻意不提供删除 / 清空——需要导出时用浏览器自带的下载。
 */
import { useEffect, useState } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { vfs } from '@/lib/persistence/vfs';
import { formatBytes } from '@/lib/utils';

function openFileBrowser(): void {
  const url = browser.runtime.getURL('/vfs.html' as never) + '#/workspaces';
  void browser.tabs.create({ url });
}

export function StorageSection() {
  // null = 计算中；number = 已用字节数；'error' = 计算失败（与「空」区分，避免误报 0 B）。
  const [usage, setUsage] = useState<number | 'error' | null>(null);

  useEffect(() => {
    let alive = true;
    // 递归累加全树文件大小（lightning-fs 的 du），进入本节时算一次。
    vfs.du('/').then(
      (bytes) => { if (alive) setUsage(bytes); },
      () => { if (alive) setUsage('error'); },
    );
    return () => { alive = false; };
  }, []);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.storage.title')}</h2>

      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
          <span className="text-sm text-muted-foreground">{t('settings.storage.used')}</span>
          {usage === null ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : usage === 'error' ? (
            <span className="text-sm text-muted-foreground">{t('settings.storage.usedError')}</span>
          ) : (
            <span className="text-sm font-medium tabular-nums">{formatBytes(usage)}</span>
          )}
        </div>

        <div className="space-y-2">
          <Button variant="outline" onClick={openFileBrowser}>
            <FolderOpen className="size-4" />
            {t('settings.storage.openBrowser')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('settings.storage.description')}</p>
        </div>
      </div>
    </div>
  );
}

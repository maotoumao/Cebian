import { useCallback } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { FileWorkspace } from './FileWorkspace';
import { encodeRelPath } from '@/lib/persistence/vfs';
import { CEBIAN_MEMORIES_DIR } from '@/lib/persistence/vfs-paths';
import { settingsFilePanelWidth, memorySettings } from '@/lib/persistence/storage';
import { useStorageItem } from '@/hooks/useStorageItem';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import type { SettingsOutletContext } from '@/components/settings/SettingsLayout';
import { t } from '@/lib/i18n';

const MEMORY_TEMPLATE = () => `---
name: new-memory
description: ""
type: user
---

${t('settings.memory.newBody')}
`;

/**
 * MemorySection — 跨对话记忆管理页（/settings/memory[/*]）。
 *
 * 顶部一个总开关（memorySettings.enabled，默认关），下面复用 FileWorkspace 直接浏览 /
 * 查看 / 编辑 / 删除 ~/.cebian/memories/ 下的记忆文件——「全量可见可删」也是敏感信息的兜底。
 * 选中文件由 splat 路由驱动，URL 可分享、前进/后退连贯。
 */
export function MemorySection() {
  const { basePath, breakpoint } = useOutletContext<SettingsOutletContext>();
  const params = useParams();
  const navigate = useNavigate();
  const [settings, setSettings] = useStorageItem(memorySettings, { enabled: false });

  // react-router v6 decodes splat params; fallback to '' means no file selected.
  const splat = params['*'] ?? '';
  const relativePath = splat || undefined;

  const handleSelect = useCallback((rel: string | null) => {
    if (rel) {
      navigate(`${basePath}/memory/${encodeRelPath(rel)}`, { replace: true });
    } else {
      navigate(`${basePath}/memory`, { replace: true });
    }
  }, [basePath, navigate]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="px-6 pt-6 pb-4 shrink-0 border-b border-border">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">{t('settings.memory.title')}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{t('settings.memory.hint')}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Label htmlFor="memory-enabled" className="text-xs text-muted-foreground">
              {t('settings.memory.enable')}
            </Label>
            <Switch
              id="memory-enabled"
              checked={settings.enabled}
              onCheckedChange={(enabled) => setSettings({ ...settings, enabled })}
            />
          </div>
        </div>
      </div>
      <FileWorkspace
        root={CEBIAN_MEMORIES_DIR}
        relativePath={relativePath}
        onSelectRelative={handleSelect}
        newFileTemplate={MEMORY_TEMPLATE()}
        panelWidthStorage={settingsFilePanelWidth}
        compactMode={breakpoint === 'compact'}
        className="flex-1"
      />
    </div>
  );
}

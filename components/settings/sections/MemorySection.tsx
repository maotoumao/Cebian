import { useCallback, useRef } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { FileWorkspace, type FileWorkspaceHandle } from './FileWorkspace';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { encodeRelPath } from '@/lib/persistence/vfs';
import { CEBIAN_MEMORIES_DIR } from '@/lib/persistence/vfs-paths';
import {
  settingsFilePanelWidth,
  memorySettings,
  memoryOrganizeState,
  resolveOrganizeSettings,
  providerCredentials,
  customProviders,
  type MemorySettings,
  type ModelIdentity,
} from '@/lib/persistence/storage';
import { useStorageItem } from '@/hooks/useStorageItem';
import { useMemoryOrganize } from '@/hooks/useMemoryOrganize';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
 * 整理控制区：手动「整理」按钮 + 整理用模型选择 + 上次整理结果。
 * 只在记忆开启时渲染。用户配置读 / 写 memorySettings.organize；运行结果读 memoryOrganizeState。
 */
function OrganizeControls({
  settings,
  setSettings,
  onOrganized,
}: {
  settings: MemorySettings;
  setSettings: (s: MemorySettings) => void;
  onOrganized: () => void;
}) {
  const organize = resolveOrganizeSettings(settings);
  const [state] = useStorageItem(memoryOrganizeState, {});
  const [providers] = useStorageItem(providerCredentials, {});
  const [customProviderList] = useStorageItem(customProviders, []);
  const { running, trigger } = useMemoryOrganize(onOrganized);

  const setModel = (model: ModelIdentity | undefined) =>
    setSettings({ ...settings, organize: { ...organize, model } });
  const setAuto = (auto: boolean) =>
    setSettings({ ...settings, organize: { ...organize, auto } });
  const setIntervalDays = (intervalDays: number) =>
    setSettings({ ...settings, organize: { ...organize, intervalDays } });
  const setMinNewMemories = (minNewMemories: number) =>
    setSettings({ ...settings, organize: { ...organize, minNewMemories } });

  return (
    <div className="mt-4 rounded-md border border-border p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-medium">{t('settings.memory.organize.title')}</span>
            {state.lastRunAt && (
              <span className="text-xs text-muted-foreground">
                {t('settings.memory.organize.lastRun', [new Date(state.lastRunAt).toLocaleString()])}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{t('settings.memory.organize.hint')}</p>
        </div>
        <Button size="sm" variant="outline" disabled={running} onClick={trigger} className="shrink-0">
          {running ? t('settings.memory.organize.running') : t('settings.memory.organize.button')}
        </Button>
      </div>

      <div className="flex items-center justify-between gap-3">
        <Label className="text-xs text-muted-foreground shrink-0">
          {t('settings.memory.organize.model')}
        </Label>
        <ModelSelector
          activeModel={organize.model ?? null}
          configuredProviders={providers}
          customProviders={customProviderList}
          onSelect={(provider, modelId) => setModel({ provider, modelId })}
          inheritOption={{
            label: t('settings.memory.organize.followActive'),
            onSelect: () => setModel(undefined),
          }}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor="memory-organize-auto" className="text-xs text-muted-foreground">
            {t('settings.memory.organize.auto')}
          </Label>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {t('settings.memory.organize.autoHint')}
          </p>
        </div>
        <Switch
          id="memory-organize-auto"
          checked={organize.auto}
          onCheckedChange={setAuto}
          className="shrink-0"
        />
      </div>

      {organize.auto && (
        <>
          <div className="flex items-center justify-between gap-3">
            <Label
              htmlFor="memory-organize-interval"
              className="text-xs text-muted-foreground shrink-0"
            >
              {t('settings.memory.organize.intervalLabel')}
            </Label>
            <Input
              id="memory-organize-interval"
              type="number"
              min={0}
              value={organize.intervalDays}
              onChange={(e) => {
                const n = Math.floor(Number(e.target.value));
                if (Number.isFinite(n)) setIntervalDays(Math.max(0, n));
              }}
              className="h-8 w-20 text-xs"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label
              htmlFor="memory-organize-threshold"
              className="text-xs text-muted-foreground shrink-0"
            >
              {t('settings.memory.organize.thresholdLabel')}
            </Label>
            <Input
              id="memory-organize-threshold"
              type="number"
              min={1}
              value={organize.minNewMemories}
              onChange={(e) => {
                const n = Math.floor(Number(e.target.value));
                if (Number.isFinite(n)) setMinNewMemories(Math.max(1, n));
              }}
              className="h-8 w-20 text-xs"
            />
          </div>
        </>
      )}
    </div>
  );
}

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
  const fileWsRef = useRef<FileWorkspaceHandle>(null);

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
        <div className="flex items-center justify-between gap-4">
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
        {settings.enabled && (
          <OrganizeControls
            settings={settings}
            setSettings={setSettings}
            onOrganized={() => fileWsRef.current?.refresh()}
          />
        )}
      </div>
      <FileWorkspace
        ref={fileWsRef}
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

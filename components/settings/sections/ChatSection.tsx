import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { SearchEngineList } from '@/components/settings/search/SearchEngineList';
import { SearchEngineEditor } from '@/components/settings/search/SearchEngineEditor';
import type { SettingsOutletContext } from '@/components/settings/SettingsLayout';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  autoTitleSettings,
  compactionModel,
  compactionSettings,
  providerCredentials,
  resolveAutoTitleSettings,
  resolveCompactionSettings,
  type CompactionSettings,
  customProviders as customProvidersStorage,
  userInstructions as userInstructionsStorage,
  searchEnginesConfig,
  resolveSearchEnginesConfig,
} from '@/lib/persistence/storage';
import {
  deleteCustomSearchEngine,
  moveSearchEngine,
  newSearchEngineDraft,
  resetBuiltinSearchEngine,
  saveSearchEngineDraft,
  setSearchEngineEnabled,
} from '@/lib/search/edit-config';
import { findSearchEngine, listSearchEngines } from '@/lib/search/engines';
import type { SearchEngineDraft, SearchEnginesConfig } from '@/lib/search/types';
import { t } from '@/lib/i18n';

/**
 * 「联网搜索」区块：引擎列表 + 启停 / 调序 / 恢复默认 / 删除。这些操作即时写入；写失败要出声。
 */
function SearchEnginesPanel({ onEditEngine }: { onEditEngine: (id: string) => void }) {
  // undefined = storage 还没读出来。这一帧不能渲染可操作的列表：拿 fallback 建出来的默认
  // 配置去改开关，会把用户的覆盖层 / 自定义引擎 / 顺序整份覆盖掉。
  const [stored] = useStorageItem(searchEnginesConfig, undefined);
  const config = stored === undefined ? null : resolveSearchEnginesConfig(stored);

  // 直接写 storage、让 watch 把成功落盘的值推回界面，而不是走 useStorageItem 的乐观 setter：
  // 乐观更新在写失败时会让开关停在假状态，而「读回旧值再写一次」的回滚又可能覆盖掉
  // 中间已成功的另一次修改。少几毫秒的即时感，换界面永远只显示真实持久化状态。
  const write = (next: SearchEnginesConfig) => {
    void searchEnginesConfig.setValue(next).catch((err) => {
      console.warn('[search] update engines failed:', err);
      toast.error(t('errors.searchEngineSaveFailed'));
    });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t('settings.chat.search.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('settings.chat.search.hint')}</p>
      </div>
      {config && (
        <SearchEngineList
          engines={listSearchEngines(config)}
          onToggle={(id, enabled) => write(setSearchEngineEnabled(config, id, enabled))}
          onMove={(id, delta) => write(moveSearchEngine(config, id, delta))}
          onReset={(id) => write(resetBuiltinSearchEngine(config, id))}
          onDelete={(id) => write(deleteCustomSearchEngine(config, id))}
          onEdit={onEditEngine}
          onCreate={() => onEditEngine(NEW_ENGINE_SEGMENT)}
        />
      )}
    </div>
  );
}

/** 压缩阈值滑杆的取值范围：低于 50% 压得过于频繁，高于 95% 就失去了提前量。 */
const THRESHOLD_MIN = 50;
const THRESHOLD_MAX = 95;
const THRESHOLD_STEP = 5;

/**
 * 压缩阈值行：滑杆 + 百分比读数。
 *
 * 拖动期间显示本地草稿值，松手（`onValueCommit`）才写 storage——受控 Slider 若等
 * storage 回程再更新会拖不动。写入落定后由 effect 撤掉草稿，交回 `percent` 作真相；
 * 外部（另一个窗口 / 恢复备份）改了阈值同样能把草稿冲掉。
 *
 * 草稿放在本组件而不是上层：压缩总开关被外部关掉时整行随之卸载，未松手的拖动值一并
 * 消失；否则重新开启会显示一个从未保存过的旧值。
 */
function CompactionThresholdRow({
  percent,
  onCommit,
}: {
  percent: number;
  onCommit: (percent: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const value = draft ?? percent;
  useEffect(() => { setDraft(null); }, [percent]);
  // Radix 的 role="slider" 在 Thumb 上，Label 的 htmlFor 指不到它；改用 aria-labelledby
  // 把可见 Label 关联过去（转发逻辑见 components/ui/slider.tsx）。
  const labelId = useId();
  const valueText = t('settings.chat.compaction.threshold.value', [String(value)]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <Label id={labelId} className="text-xs text-muted-foreground">
          {t('settings.chat.compaction.threshold.label')}
        </Label>
        <span className="shrink-0 text-xs tabular-nums" aria-hidden="true">{valueText}</span>
      </div>
      <Slider
        value={[value]}
        min={THRESHOLD_MIN}
        max={THRESHOLD_MAX}
        step={THRESHOLD_STEP}
        aria-labelledby={labelId}
        aria-valuetext={valueText}
        onValueChange={([next]) => setDraft(next)}
        onValueCommit={([next]) => onCommit(next)}
      />
      <p className="text-xs text-muted-foreground">
        {t('settings.chat.compaction.threshold.hint')}
      </p>
    </div>
  );
}

/**
 * 「上下文压缩」区块：总开关 + 触发阈值 + 压缩专用模型。
 *
 * 开关与阈值同属 `compactionSettings`；模型是独立存储项 `compactionModel`（既有持久化
 * key，不并入——改 key 会静默丢掉用户已有的配置）。模型 `null` = 跟随对话主模型，复用
 * 聊天的 `ModelSelector`，由 `inheritOption` 提供「与对话模型相同」首项。
 *
 * 写入沿用 `SearchEnginesPanel` 的做法：直接写 storage、让 watch 把成功落盘的值推回界面，
 * 而不是 `useStorageItem` 的乐观 setter——乐观更新在写失败时会让开关/滑杆停在假值，后台
 * 却还在用旧配置，且用户看不到任何提示。
 */
function CompactionPanel() {
  // undefined = storage 还没读出来。这一帧不能让开关可操作：拿默认值整对象回写会把用户
  // 已存的阈值抹掉（同 SearchEnginesPanel 的守卫）。归一化交给 resolveCompactionSettings。
  const [stored] = useStorageItem(compactionSettings, undefined);
  const loaded = stored !== undefined;
  const settings = resolveCompactionSettings(stored);
  const [model, setModel] = useStorageItem(compactionModel, null);
  const [providers] = useStorageItem(providerCredentials, {});
  const [customProviderList] = useStorageItem(customProvidersStorage, []);

  const write = (next: CompactionSettings) => {
    void compactionSettings.setValue(next).catch((err) => {
      console.warn('[compaction] update settings failed:', err);
      toast.error(t('errors.compactionSettingsSaveFailed'));
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="compaction-auto" className="text-sm">{t('settings.chat.compaction.auto.label')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.chat.compaction.auto.hint')}
          </p>
        </div>
        <Switch
          id="compaction-auto"
          checked={settings.enabled}
          disabled={!loaded}
          onCheckedChange={(enabled) => write({ ...settings, enabled })}
          className="shrink-0"
        />
      </div>
      {loaded && settings.enabled && (
        <>
          <CompactionThresholdRow
            percent={settings.thresholdPercent}
            onCommit={(thresholdPercent) => write({ ...settings, thresholdPercent })}
          />
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <Label className="text-xs text-muted-foreground">{t('settings.chat.compaction.model.label')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('settings.chat.compaction.model.hint')}
              </p>
            </div>
            <div className="shrink-0">
              <ModelSelector
                activeModel={model}
                configuredProviders={providers}
                customProviders={customProviderList}
                onSelect={(provider, modelId) => setModel({ provider, modelId })}
                inheritOption={{
                  label: t('settings.chat.compaction.model.followMain'),
                  onSelect: () => setModel(null),
                }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 「对话」主面板：每次对话怎么运作。四块内容都只影响对话本身，故合为一节：
 * - 自定义指引：追加到系统提示词末尾的用户规则。
 * - 上下文压缩：总开关 + 触发阈值 + 压缩专用模型，见 `CompactionPanel`。
 * - 自动标题：首轮结束后用一次短补全替换默认标题（可关；model null = 跟随对话主模型）。
 * - 联网搜索：`web_search` 工具用哪些引擎、按什么顺序回退。
 */
function ChatPanel({ onEditEngine }: { onEditEngine: (id: string) => void }) {
  const [currentInstructions, setCurrentInstructions] = useStorageItem(userInstructionsStorage, '');
  // undefined = storage 还没读出来。这一帧不能让开关可操作：拿默认值整对象回写会把用户已选的
  // 标题模型抹掉（同 SearchEnginesPanel 的守卫）。归一化交给 resolveAutoTitleSettings。
  const [autoTitleRaw, setAutoTitle] = useStorageItem(autoTitleSettings, undefined);
  const autoTitleLoaded = autoTitleRaw !== undefined;
  const autoTitle = resolveAutoTitleSettings(autoTitleRaw);
  const [providers] = useStorageItem(providerCredentials, {});
  const [customProviderList] = useStorageItem(customProvidersStorage, []);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.chat.title')}</h2>

      <div className="space-y-2">
        <Label htmlFor="user-instructions" className="text-sm">{t('settings.chat.instructions.label')}</Label>
        <p className="text-xs text-muted-foreground">
          {t('settings.chat.instructions.hint')}
        </p>
        <Textarea
          id="user-instructions"
          value={currentInstructions}
          onChange={(e) => setCurrentInstructions(e.target.value)}
          placeholder={t('settings.chat.instructions.placeholder')}
          rows={8}
          maxLength={2000}
          className="text-xs min-h-64 max-h-96 overflow-y-auto"
        />
        <p className="text-xs text-muted-foreground text-right" aria-live="polite">
          {currentInstructions.length} / 2000
        </p>
      </div>

      <CompactionPanel />

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="auto-title-enabled" className="text-sm">{t('settings.chat.autoTitle.label')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('settings.chat.autoTitle.hint')}
            </p>
          </div>
          <Switch
            id="auto-title-enabled"
            checked={autoTitle.enabled}
            disabled={!autoTitleLoaded}
            onCheckedChange={(enabled) => setAutoTitle({ ...autoTitle, enabled })}
            className="shrink-0"
          />
        </div>
        {autoTitleLoaded && autoTitle.enabled && (
          <div className="flex items-center justify-between gap-4">
            <Label className="text-xs text-muted-foreground">{t('settings.chat.autoTitle.model')}</Label>
            <div className="shrink-0">
              <ModelSelector
                activeModel={autoTitle.model}
                configuredProviders={providers}
                customProviders={customProviderList}
                onSelect={(provider, modelId) => setAutoTitle({ ...autoTitle, model: { provider, modelId } })}
                inheritOption={{
                  label: t('settings.chat.autoTitle.followMain'),
                  onSelect: () => setAutoTitle({ ...autoTitle, model: null }),
                }}
              />
            </div>
          </div>
        )}
      </div>

      <SearchEnginesPanel onEditEngine={onEditEngine} />
    </div>
  );
}

/** 编辑页的「新建」占位段：URL 里出现 `engine/new` 表示还没落库的新引擎。 */
const NEW_ENGINE_SEGMENT = 'new';

/** 按 id 从配置取出可编辑草稿；引擎不存在返回 null。 */
function draftFor(config: SearchEnginesConfig, engineId: string): SearchEngineDraft | null {
  const engine = findSearchEngine(config, engineId);
  if (!engine) return null;
  return {
    id: engine.id,
    kind: engine.kind,
    name: engine.name,
    urlTemplate: engine.urlTemplate,
    extract: engine.extract,
    when: engine.when ?? '',
  };
}

/**
 * 编辑页：按 id 从配置取出草稿（`new` 则起一份预填模板的草稿），保存后回列表。
 *
 * 草稿必须等 storage **真正加载完**再生成：`useStorageItem` 首帧给的是 fallback（这里传
 * undefined 正好当作「还没加载」的信号），拿它建草稿会让已有引擎查不到、已有覆盖层被
 * 空值覆盖。故 `undefined` 期间什么都不做，加载完只初始化一次。
 */
function EngineEditorRoute({ engineId, onBack }: { engineId: string; onBack: () => void }) {
  const [stored, setStored] = useStorageItem(searchEnginesConfig, undefined);
  const [initial, setInitial] = useState<SearchEngineDraft | null>(null);
  const [gone, setGone] = useState(false);
  const [saving, setSaving] = useState(false);
  // 写入是异步的，期间用户可能已经离开这个路由；卸载后就不该再导航、弹 toast 或改状态。
  // setup 里要重新置 true：StrictMode 会 setup → cleanup → setup 跑一遍，否则标记卡在 false。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loaded = stored !== undefined;

  useEffect(() => {
    if (!loaded || initial || gone) return;
    const config = resolveSearchEnginesConfig(stored);
    const draft = engineId === NEW_ENGINE_SEGMENT ? newSearchEngineDraft(config) : draftFor(config, engineId);
    if (draft) setInitial(draft);
    else setGone(true);
  }, [loaded, stored, engineId, initial, gone]);

  // 引擎不存在（多端删除 / 手改数据 / 陈旧链接）：回列表。导航放 effect 里做，
  // render 期调 navigate 会触发 React 的「渲染时更新另一个组件」告警。
  useEffect(() => {
    if (gone) onBack();
  }, [gone, onBack]);

  if (!initial) return null;

  const handleSave = async (draft: SearchEngineDraft) => {
    const config = resolveSearchEnginesConfig(stored);
    // 编辑期间这个自定义引擎被别处删掉了：upsert 会把它静默复活，宁可告知并回列表。
    if (draft.kind === 'custom' && engineId !== NEW_ENGINE_SEGMENT && !config.custom.some((e) => e.id === draft.id)) {
      toast.error(t('errors.searchEngineGone'));
      onBack();
      return;
    }
    setSaving(true);
    try {
      await setStored(saveSearchEngineDraft(config, draft));
      if (mountedRef.current) onBack();
    } catch (err) {
      // 写入失败就留在编辑页，别把用户刚填的内容随卸载一起丢掉。
      console.warn('[search] save engine failed:', err);
      if (mountedRef.current) toast.error(t('errors.searchEngineSaveFailed'));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  return <SearchEngineEditor initial={initial} saving={saving} onSave={handleSave} onBack={onBack} />;
}

/**
 * ChatSection — 「对话」设置（挂在 `chat/*`）。主面板与单个搜索引擎的编辑页是同一个
 * section 的两个视图，用子路由切换而不是弹窗：侧边栏窄，脚本编辑器需要整幅宽度；
 * 设置导航刻意不为编辑页新增 tab。
 */
export function ChatSection() {
  const { basePath } = useOutletContext<SettingsOutletContext>();
  const params = useParams();
  const navigate = useNavigate();

  const splat = params['*'] ?? '';
  const editingId = splat.startsWith('engine/') ? splat.slice('engine/'.length) : null;

  const backToList = useCallback(() => {
    navigate(`${basePath}/chat`, { replace: true });
  }, [basePath, navigate]);

  const editEngine = useCallback(
    (id: string) => {
      navigate(`${basePath}/chat/engine/${id}`, { replace: true });
    },
    [basePath, navigate],
  );

  if (editingId) {
    // key：切换编辑对象时重建组件，让草稿的初始值重新求值。
    return <EngineEditorRoute key={editingId} engineId={editingId} onBack={backToList} />;
  }
  return <ChatPanel onEditEngine={editEngine} />;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { SearchEngineList } from '@/components/settings/search/SearchEngineList';
import { SearchEngineEditor } from '@/components/settings/search/SearchEngineEditor';
import type { SettingsOutletContext } from '@/components/settings/SettingsLayout';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  compactionModel,
  providerCredentials,
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

/**
 * 「对话」主面板：每次对话怎么运作。三块内容都只影响对话本身，故合为一节：
 * - 自定义指引：追加到系统提示词末尾的用户规则。
 * - 压缩模型：上下文压缩（摘要）专用模型。`null` = 跟随对话主模型（默认）；复用聊天的
 *   `ModelSelector`，通过 `inheritOption` 提供「与对话模型相同」首项（写回 null）。
 * - 联网搜索：`web_search` 工具用哪些引擎、按什么顺序回退。
 */
function ChatPanel({ onEditEngine }: { onEditEngine: (id: string) => void }) {
  const [currentInstructions, setCurrentInstructions] = useStorageItem(userInstructionsStorage, '');
  const [model, setModel] = useStorageItem(compactionModel, null);
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

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label className="text-sm">{t('settings.chat.compaction.label')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.chat.compaction.hint')}
          </p>
        </div>
        <div className="shrink-0">
          <ModelSelector
            activeModel={model}
            configuredProviders={providers}
            customProviders={customProviderList}
            onSelect={(provider, modelId) => setModel({ provider, modelId })}
            inheritOption={{
              label: t('settings.chat.compaction.followMain'),
              onSelect: () => setModel(null),
            }}
          />
        </div>
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

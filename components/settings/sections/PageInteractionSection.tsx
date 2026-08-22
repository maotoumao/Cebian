import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { PageScopeEditor } from '@/components/settings/page-interaction/PageScopeEditor';
import { ToolbarActionList } from '@/components/settings/page-interaction/ToolbarActionList';
import { ToolbarActionEditor } from '@/components/settings/page-interaction/ToolbarActionEditor';
import type { SettingsOutletContext } from '@/components/settings/SettingsLayout';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  pageActionsConfig,
  pageInteractionSettings,
  resolvePageActionsConfig,
  resolvePageInteractionSettings,
  providerCredentials,
  customProviders as customProvidersStorage,
  type PageInteractionSettings,
} from '@/lib/persistence/storage';
import { listPageActions } from '@/lib/page-actions/actions';
import { resolvePageScope, type PageScope } from '@/lib/page-actions/match';
import {
  deleteCustomAction,
  moveAction,
  newActionDraft,
  saveActionDraft,
  setActionEnabled,
} from '@/lib/page-actions/edit-config';
import { isBuiltinPageActionId, type PageActionDraft, type PageActionsConfig } from '@/lib/page-actions/types';
import { t } from '@/lib/i18n';

/** 悬浮球 / 工具条的生效范围字段。两块 UI 的干扰场景不同（用户要求分开配置），故各挂
 *  一份；缩进一级表示它从属上面那个开关。 */
function PageScopeField({
  scope,
  onChange,
  disabled,
}: {
  scope: PageScope;
  onChange: (next: PageScope) => void;
  disabled: boolean;
}) {
  return (
    <div className="pl-1">
      <PageScopeEditor scope={scope} onChange={onChange} disabled={disabled} />
    </div>
  );
}

/**
 * 页面交互设置的主面板：两块 UI 的显示开关与页面生效范围、工具条模型（复用聊天的
 * `ModelSelector`，`inheritOption` 提供「跟随主模型」）、工具条动作列表。
 * 翻译目标语言不在这里——它是「翻译」动作的专属参数，住在那个动作的编辑页。
 */
function PageInteractionPanel({ onEditAction }: { onEditAction: (id: string) => void }) {
  const [stored, setStored] = useStorageItem(pageInteractionSettings, undefined);
  const [providers] = useStorageItem(providerCredentials, {});
  const [customProviderList] = useStorageItem(customProvidersStorage, []);
  const [storedActions, setStoredActions] = useStorageItem(pageActionsConfig, undefined);

  const settings = resolvePageInteractionSettings(stored);
  const patch = (next: Partial<PageInteractionSettings>) =>
    setStored({ ...settings, ...next });

  const actionsConfig = resolvePageActionsConfig(storedActions);
  const actions = listPageActions(actionsConfig);
  // 列表上的启停 / 调序 / 删除都是即时写入；写失败要出声，否则用户以为改上了。
  const writeActions = (next: PageActionsConfig) => {
    void setStoredActions(next).catch((err) => {
      console.warn('[page-actions] update actions failed:', err);
      toast.error(t('errors.pageActionSaveFailed'));
    });
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.pageInteraction.title')}</h2>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="page-show-ball" className="text-sm">
              {t('settings.pageInteraction.ball.label')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('settings.pageInteraction.ball.hint')}
            </p>
          </div>
          <Switch
            id="page-show-ball"
            checked={settings.showFloatingBall}
            onCheckedChange={(v) => patch({ showFloatingBall: v })}
            className="shrink-0"
          />
        </div>
        <PageScopeField
          scope={settings.ballPages}
          onChange={(next) => patch({ ballPages: next })}
          disabled={!settings.showFloatingBall}
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="page-show-toolbar" className="text-sm">
              {t('settings.pageInteraction.toolbar.label')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('settings.pageInteraction.toolbar.hint')}
            </p>
          </div>
          <Switch
            id="page-show-toolbar"
            checked={settings.showSelectionToolbar}
            onCheckedChange={(v) => patch({ showSelectionToolbar: v })}
            className="shrink-0"
          />
        </div>
        <PageScopeField
          scope={settings.toolbarPages}
          onChange={(next) => patch({ toolbarPages: next })}
          disabled={!settings.showSelectionToolbar}
        />
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label className="text-sm">{t('settings.pageInteraction.model.label')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.pageInteraction.model.hint')}
          </p>
        </div>
        <div className="shrink-0">
          <ModelSelector
            activeModel={settings.toolbarModel ?? null}
            configuredProviders={providers}
            customProviders={customProviderList}
            onSelect={(provider, modelId) => patch({ toolbarModel: { provider, modelId } })}
            inheritOption={{
              label: t('settings.pageInteraction.model.followMain'),
              onSelect: () => patch({ toolbarModel: undefined }),
            }}
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="space-y-1">
          <Label className="text-sm">{t('settings.pageInteraction.actions.title')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.pageInteraction.actions.hint')}
          </p>
        </div>
        <ToolbarActionList
          actions={actions}
          onToggle={(id, enabled) => writeActions(setActionEnabled(actionsConfig, id, enabled))}
          onMove={(id, delta) => writeActions(moveAction(actionsConfig, id, delta))}
          onDelete={(id) => writeActions(deleteCustomAction(actionsConfig, id))}
          onEdit={onEditAction}
          onCreate={() => onEditAction(NEW_ACTION_SEGMENT)}
        />
      </div>
    </div>
  );
}

/** 编辑页的「新建」占位段：URL 里出现 `action/new` 表示还没落库的新动作。 */
const NEW_ACTION_SEGMENT = 'new';

/** 按 id 从配置取出可编辑草稿；动作不存在返回 null。
 *  `translateTarget` 只给内置「翻译」动作带上——它是那个动作的专属参数，值来自
 *  `pageInteractionSettings`（既有持久化 key，只搬 UI 不搬存储）。 */
function draftFor(
  config: PageActionsConfig,
  actionId: string,
  translateTarget: string,
): PageActionDraft | null {
  const action = listPageActions(config).find((a) => a.id === actionId);
  if (!action) return null;
  return {
    id: action.id,
    kind: action.kind,
    // 内置动作的 label 已回落成界面文案，编辑框要显示「用户到底改没改」，
    // 故这里回读原始 overlay 值而不是解析后的显示名。
    label: rawLabel(config, action.id, action.kind),
    systemPrompt: config.custom.find((a) => a.id === action.id)?.systemPrompt ?? '',
    pages: resolvePageScope(action.pages),
    transform: action.transform ?? '',
    ...(action.id === 'translate' ? { translateTarget } : {}),
  };
}

/**
 * 编辑页：按 id 从配置取出草稿（`new` 则起一份空白草稿），保存后回列表。
 *
 * 草稿必须等 storage **真正加载完**再生成：`useStorageItem` 首帧给的是 fallback
 * （这里传 undefined 正好当作「还没加载」的信号），拿它建草稿会让已有动作查不到、
 * 已有 overlay 被空值覆盖。故 `undefined` 期间什么都不做，加载完只初始化一次。
 */
function ActionEditorRoute({ actionId, onBack }: { actionId: string; onBack: () => void }) {
  const [storedActions, setStoredActions] = useStorageItem(pageActionsConfig, undefined);
  // 翻译动作的目标语言仍存在 pageInteractionSettings（已发布的持久化 key），编辑页只是
  // 把它的控件收拢过来，故这里也要读写那一份设置。
  const [storedSettings, setStoredSettings] = useStorageItem(pageInteractionSettings, undefined);
  const [initial, setInitial] = useState<PageActionDraft | null>(null);
  const [gone, setGone] = useState(false);
  const [saving, setSaving] = useState(false);
  // 写入是异步的，期间用户可能已经离开这个路由；卸载后就不该再导航、弹 toast 或改状态。
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  // 两份 storage 都得等到真正加载完：任一还是 undefined 就先不建草稿。
  const loaded = storedActions !== undefined && storedSettings !== undefined;

  useEffect(() => {
    if (!loaded || initial || gone) return;
    const config = resolvePageActionsConfig(storedActions);
    const settings = resolvePageInteractionSettings(storedSettings);
    const draft =
      actionId === NEW_ACTION_SEGMENT
        ? newActionDraft(config)
        : draftFor(config, actionId, settings.translateTarget);
    if (draft) setInitial(draft);
    else setGone(true);
  }, [loaded, storedActions, storedSettings, actionId, initial, gone]);

  // 动作不存在（多端删除 / 手改数据 / 陈旧链接）：回列表。导航放 effect 里做，
  // render 期调 navigate 会触发 React 的「渲染时更新另一个组件」告警。
  useEffect(() => {
    if (gone) onBack();
  }, [gone, onBack]);

  // 加载中或正要回列表：不渲染半成品表单。
  if (!initial) return null;

  const handleSave = async (draft: PageActionDraft) => {
    const config = resolvePageActionsConfig(storedActions);
    // 编辑期间这个自定义动作被别处删掉了：upsert 会把它静默复活，宁可告知并回列表。
    if (draft.kind === 'custom' && actionId !== NEW_ACTION_SEGMENT) {
      if (!config.custom.some((a) => a.id === draft.id)) {
        toast.error(t('errors.pageActionGone'));
        onBack();
        return;
      }
    }
    setSaving(true);
    try {
      await setStoredActions(saveActionDraft(config, draft));
      // 翻译目标语言是另一份 storage item，跟着同一次保存写回。
      //
      // 「有没有改过」拿**表单初值**比，不能拿 storedSettings 比：useStorageItem 的 setValue
      // 是先乐观更新本地 state 再落库，若上一次落库失败，本地已是新值，再比就会得出「没改」
      // 而跳过写入——用户看到保存成功，storage 里还是旧值。
      if (draft.translateTarget !== undefined && draft.translateTarget !== initial.translateTarget) {
        const settings = resolvePageInteractionSettings(storedSettings);
        await setStoredSettings({ ...settings, translateTarget: draft.translateTarget });
      }
      if (mountedRef.current) onBack();
    } catch (err) {
      // 写入失败就留在编辑页，别把用户刚填的内容随卸载一起丢掉。
      console.warn('[page-actions] save action failed:', err);
      if (mountedRef.current) toast.error(t('errors.pageActionSaveFailed'));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <ToolbarActionEditor initial={initial} saving={saving} onSave={handleSave} onBack={onBack} />
  );
}

/** 取用户为某动作显式设置过的名字（没设置就是空串——编辑框留空即「跟随界面语言」）。 */
function rawLabel(config: PageActionsConfig, id: string, kind: 'builtin' | 'custom'): string {
  if (kind === 'custom') return config.custom.find((a) => a.id === id)?.label ?? '';
  return isBuiltinPageActionId(id) ? config.builtin[id]?.label ?? '' : '';
}

/**
 * PageInteractionSection — 页面交互设置（挂在 `page-interaction/*`）。
 *
 * 主面板与单个动作的编辑页是同一个 section 的两个视图，用子路由切换而不是弹窗：
 * 侧边栏窄，编辑页里的提示词编辑器与规则列表需要整幅宽度。设置导航刻意不为编辑页
 * 新增 tab（现有 tab 已偏多）。
 */
export function PageInteractionSection() {
  const { basePath } = useOutletContext<SettingsOutletContext>();
  const params = useParams();
  const navigate = useNavigate();

  const splat = params['*'] ?? '';
  const editingId = splat.startsWith('action/') ? splat.slice('action/'.length) : null;

  const backToList = useCallback(() => {
    navigate(`${basePath}/page-interaction`, { replace: true });
  }, [basePath, navigate]);

  const editAction = useCallback(
    (id: string) => {
      navigate(`${basePath}/page-interaction/action/${id}`, { replace: true });
    },
    [basePath, navigate],
  );

  if (editingId) {
    // key：切换编辑对象时重建组件，让草稿的初始值重新求值。
    return <ActionEditorRoute key={editingId} actionId={editingId} onBack={backToList} />;
  }
  return <PageInteractionPanel onEditAction={editAction} />;
}

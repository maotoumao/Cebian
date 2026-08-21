import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Check, ChevronDown } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { PagePatternsEditor } from '@/components/settings/page-interaction/PagePatternsEditor';
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
import {
  deleteCustomAction,
  moveAction,
  newActionDraft,
  saveActionDraft,
  setActionEnabled,
} from '@/lib/page-actions/edit-config';
import { isBuiltinPageActionId, type PageActionDraft, type PageActionsConfig } from '@/lib/page-actions/types';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

// 翻译目标语言的 BCP-47 代码。标签在渲染时由 Intl.DisplayNames 用「各语言本名
// （endonym）」生成，故源码只含 ASCII 代码，无需为语言名维护三语翻译，任何界面语言
// 下都显示成该语言自己的写法。空串（跟随界面语言）作为单独首项在选择器里处理。
const TRANSLATE_TARGETS = [
  'en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt', 'it', 'ar',
] as const;

/** 用目标语言自身显示其语言名（endonym）；不支持时回退代码本身。 */
function endonym(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** 翻译目标语言选择器：Popover + 列表，首项为「跟随界面语言」（写回空串）。 */
function TranslateTargetSelector({
  value,
  onSelect,
}: {
  value: string;
  onSelect: (target: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const currentLabel = value
    ? endonym(value)
    : t('settings.pageInteraction.translate.auto');

  const renderRow = (rowValue: string, label: string) => (
    <button
      key={rowValue || 'auto'}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none',
        'hover:bg-accent hover:text-accent-foreground',
        value === rowValue && 'bg-accent/50',
      )}
      onClick={() => {
        onSelect(rowValue);
        setOpen(false);
      }}
    >
      {label}
      <Check
        className={cn('ml-auto size-4', value === rowValue ? 'opacity-100' : 'opacity-0')}
      />
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="min-w-32 justify-between">
          {currentLabel}
          <ChevronDown data-icon />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-44 p-1" align="end">
        <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
          {renderRow('', t('settings.pageInteraction.translate.auto'))}
          {TRANSLATE_TARGETS.map((code) => renderRow(code, endonym(code)))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** 「在这些页面隐藏」字段：标签 + 说明 + 规则列表。悬浮球与工具条各挂一份（两块 UI
 *  的干扰场景不同，用户要求分开配置），故抽出来避免同一段结构写两遍。 */
function HiddenPagesField({
  patterns,
  onChange,
  disabled,
}: {
  patterns: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  const labelId = useId();
  return (
    <div className={cn('space-y-1.5 pl-1', disabled && 'pointer-events-none opacity-50')}>
      <Label id={labelId} className="text-xs font-normal text-muted-foreground">
        {t('settings.pageInteraction.hiddenPages.label')}
      </Label>
      <PagePatternsEditor
        patterns={patterns}
        onChange={onChange}
        disabled={disabled}
        labelledBy={labelId}
      />
      <p className="text-xs text-muted-foreground">
        {t('settings.pageInteraction.hiddenPages.hint')}
      </p>
    </div>
  );
}

/**
 * 页面交互设置的主面板：两块 UI 的显示开关与隐藏页面、工具条模型（复用聊天的
 * `ModelSelector`，`inheritOption` 提供「跟随主模型」）、翻译目标语言、工具条动作列表。
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
        <HiddenPagesField
          patterns={settings.ballHiddenPages}
          onChange={(next) => patch({ ballHiddenPages: next })}
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
        <HiddenPagesField
          patterns={settings.toolbarHiddenPages}
          onChange={(next) => patch({ toolbarHiddenPages: next })}
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

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <Label className="text-sm">{t('settings.pageInteraction.translate.label')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.pageInteraction.translate.hint')}
          </p>
        </div>
        <div className="shrink-0">
          <TranslateTargetSelector
            value={settings.translateTarget}
            onSelect={(target) => patch({ translateTarget: target })}
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

/** 按 id 从配置取出可编辑草稿；动作不存在返回 null。 */
function draftFor(config: PageActionsConfig, actionId: string): PageActionDraft | null {
  const action = listPageActions(config).find((a) => a.id === actionId);
  if (!action) return null;
  return {
    id: action.id,
    kind: action.kind,
    // 内置动作的 label 已回落成界面文案，编辑框要显示「用户到底改没改」，
    // 故这里回读原始 overlay 值而不是解析后的显示名。
    label: rawLabel(config, action.id, action.kind),
    systemPrompt: config.custom.find((a) => a.id === action.id)?.systemPrompt ?? '',
    pages: [...action.pages],
    transform: action.transform ?? '',
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
  const [initial, setInitial] = useState<PageActionDraft | null>(null);
  const [gone, setGone] = useState(false);
  const [saving, setSaving] = useState(false);
  // 写入是异步的，期间用户可能已经离开这个路由；卸载后就不该再导航、弹 toast 或改状态。
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const loaded = storedActions !== undefined;

  useEffect(() => {
    if (!loaded || initial || gone) return;
    const config = resolvePageActionsConfig(storedActions);
    const draft =
      actionId === NEW_ACTION_SEGMENT ? newActionDraft(config) : draftFor(config, actionId);
    if (draft) setInitial(draft);
    else setGone(true);
  }, [loaded, storedActions, actionId, initial, gone]);

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

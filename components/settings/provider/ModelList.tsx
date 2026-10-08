import { useEffect, useRef, useState, type RefObject } from 'react';
import { CheckSquare, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { Accordion } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { ModelListItem, type ModelFieldPatch } from '@/components/settings/provider/ModelListItem';
import { RemoteModelPickerDialog } from '@/components/settings/provider/RemoteModelPickerDialog';
import type { CustomModelDef } from '@/lib/persistence/storage';
import { t } from '@/lib/i18n';

// ─── Manual "add model by id" control ───

/**
 * 手动添加模型的入口。静息态是一个整行按钮，点开才露出输入框——避免裸输入框和上方
 * 展开的模型配置混在一起（动线不清），也让「输入后要按回车/点添加」这个动作显式化
 */
function ManualAddModel({
  value,
  onChange,
  onAdd,
  triggerRef,
}: {
  value: string;
  onChange: (v: string) => void;
  onAdd: () => void;
  /** 静息态「手动添加模型」按钮，供退出选择模式时兜底接焦点。 */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const open = () => {
    setAdding(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const cancel = () => {
    setAdding(false);
    onChange('');
  };

  const submit = () => {
    if (!value.trim()) return;
    onAdd();
    // 保持展开并重新聚焦，便于连续添加
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  if (!adding) {
    return (
      <Button ref={triggerRef} variant="outline" size="sm" className="w-full" onClick={open}>
        <Plus className="size-3.5" />
        {t('provider.form.addManual')}
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        ref={inputRef}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        }}
        onBlur={() => { if (!value.trim()) setAdding(false); }}
        placeholder={t('provider.form.manualModelPlaceholder')}
        className="h-7 text-xs flex-1"
      />
      <Button size="sm" onClick={submit} disabled={!value.trim()}>
        {t('common.add')}
      </Button>
      <Button variant="ghost" size="icon-xs" onClick={cancel} aria-label={t('common.cancel')}>
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

// ─── Model list section ───

interface ModelListProps {
  models: CustomModelDef[];
  /** 端点地址已填，「自动获取」才可用。 */
  canFetch: boolean;
  fetching: boolean;
  fetchError: string;
  /** 「自动获取」拿到、等待勾选的远端模型 id；`null` = 勾选弹窗未打开。 */
  pickerRemoteIds: string[] | null;
  manualModelId: string;
  onManualModelIdChange: (value: string) => void;
  onFetchModels: () => void;
  onConfirmPicked: (selected: ReadonlySet<string>) => void;
  onCancelPick: () => void;
  onAddManualModel: () => void;
  onRemoveModels: (modelIds: string[]) => void;
  onToggleReasoning: (modelId: string) => void;
  onToggleImage: (modelId: string) => void;
  onModelFieldChange: (modelId: string, patch: ModelFieldPatch) => void;
}

/**
 * 自定义提供商表单里的「模型列表」一节：自动获取（勾选弹窗）、逐个配置、手动添加，以及
 * 多选批量删除（issue #86）。
 *
 * 选择模式沿用历史面板的写法：`selectedIds` 为 `null` 即不在选择模式，省掉「布尔 + 集合」
 * 互相矛盾的状态。选择模式下行内的开关 / 删除 / 展开都收起来，窄侧栏里只剩复选框和 id。
 * 删除只改表单草稿（「保存」才落库、「取消」即恢复），所以不再二次确认。
 */
function ModelList({
  models,
  canFetch,
  fetching,
  fetchError,
  pickerRemoteIds,
  manualModelId,
  onManualModelIdChange,
  onFetchModels,
  onConfirmPicked,
  onCancelPick,
  onAddManualModel,
  onRemoveModels,
  onToggleReasoning,
  onToggleImage,
  onModelFieldChange,
}: ModelListProps) {
  // 勾选弹窗关闭后把焦点还给「自动获取」——弹窗不是由 DialogTrigger 打开的，Radix 自己找不到触发元素
  const fetchButtonRef = useRef<HTMLButtonElement>(null);
  const selectButtonRef = useRef<HTMLButtonElement>(null);
  const exitButtonRef = useRef<HTMLButtonElement>(null);
  const manualAddRef = useRef<HTMLButtonElement>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null);
  const selectionMode = selectedIds !== null;

  // 进入选择模式时「选择」按钮被卸掉，把焦点接到退出按钮上（同时告诉用户怎么退出）。
  useEffect(() => {
    if (!selectionMode) return;
    const frame = requestAnimationFrame(() => exitButtonRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [selectionMode]);

  // 已选里可能残留列表里已经没有的 id，一律按当前列表取交集，不另做同步。
  const selectedModelIds = selectionMode ? models.filter(m => selectedIds.has(m.modelId)).map(m => m.modelId) : [];
  const allState: boolean | 'indeterminate' =
    selectedModelIds.length === 0 ? false : selectedModelIds.length === models.length ? true : 'indeterminate';

  const enterSelection = () => {
    // 选择模式下手动添加整块收起，一并丢掉没提交的输入，免得退出后再点开时冒出旧草稿
    onManualModelIdChange('');
    setSelectedIds(new Set());
  };

  const exitSelection = () => {
    setSelectedIds(null);
    // 退出后焦点回到「选择」；列表删空时它不再显示，依次退到「自动获取」（地址为空时禁用）、
    // 「手动添加模型」
    requestAnimationFrame(() => {
      const target = [selectButtonRef, fetchButtonRef, manualAddRef]
        .map(ref => ref.current)
        .find(el => el && !el.disabled);
      target?.focus();
    });
  };

  const toggleAll = () => {
    setSelectedIds(allState === true ? new Set() : new Set(models.map(m => m.modelId)));
  };

  const toggle = (modelId: string, checked: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (checked) next.add(modelId);
      else next.delete(modelId);
      return next;
    });
  };

  const deleteSelected = () => {
    onRemoveModels(selectedModelIds);
    exitSelection();
  };

  return (
    <div className="space-y-2">
      <div className="flex min-h-6 items-center gap-2">
        {selectionMode ? (
          <>
            <Checkbox checked={allState} onCheckedChange={toggleAll} aria-label={t('common.selectAll')} />
            <span className="min-w-0 truncate text-xs font-medium">
              {t('common.selectedCount', selectedModelIds.length)}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              <Button
                variant="ghost"
                size="xs"
                className="text-destructive hover:text-destructive"
                disabled={selectedModelIds.length === 0}
                onClick={deleteSelected}
              >
                <Trash2 className="size-3" />
                {t('common.delete')}
              </Button>
              <Button
                ref={exitButtonRef}
                variant="ghost"
                size="icon-xs"
                aria-label={t('common.cancel')}
                onClick={exitSelection}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          </>
        ) : (
          <>
            <Label className="text-xs">{t('provider.form.models')}</Label>
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              {models.length > 0 && (
                // 拉取在途时不让进入选择模式：结果回来会在选择模式上弹出勾选框
                <Button ref={selectButtonRef} variant="ghost" size="xs" disabled={fetching} onClick={enterSelection}>
                  <CheckSquare className="size-3" />
                  {t('common.select')}
                </Button>
              )}
              <Button
                ref={fetchButtonRef}
                variant="ghost"
                size="xs"
                onClick={onFetchModels}
                disabled={fetching || !canFetch}
              >
                {fetching ? <Spinner className="size-3" /> : <RefreshCw className="size-3" />}
                {t('provider.form.autoFetch')}
              </Button>
            </div>
          </>
        )}
      </div>

      {fetchError && (
        <p className="text-xs text-destructive">{fetchError}</p>
      )}

      {pickerRemoteIds && (
        <RemoteModelPickerDialog
          remoteIds={pickerRemoteIds}
          existingIds={new Set(models.map(m => m.modelId))}
          returnFocusRef={fetchButtonRef}
          onConfirm={onConfirmPicked}
          onCancel={onCancelPick}
        />
      )}

      {models.length > 0 && (selectionMode ? (
        <div className="divide-y divide-border/50">
          {models.map(m => (
            <label key={m.modelId} className="flex cursor-pointer items-center gap-2 py-1.5 text-xs">
              <Checkbox checked={selectedIds.has(m.modelId)} onCheckedChange={v => toggle(m.modelId, v === true)} />
              <span className="min-w-0 truncate font-mono" title={m.modelId}>{m.modelId}</span>
            </label>
          ))}
        </div>
      ) : (
        <Accordion type="multiple" className="divide-y divide-border/50">
          {models.map(m => (
            <ModelListItem
              key={m.modelId}
              model={m}
              onToggleReasoning={onToggleReasoning}
              onToggleImage={onToggleImage}
              onRemove={modelId => onRemoveModels([modelId])}
              onFieldChange={onModelFieldChange}
            />
          ))}
        </Accordion>
      ))}

      {!selectionMode && (
        <ManualAddModel
          value={manualModelId}
          onChange={onManualModelIdChange}
          onAdd={onAddManualModel}
          triggerRef={manualAddRef}
        />
      )}
    </div>
  );
}

export { ModelList };

import { useState, useRef } from 'react';
import { Plus, Trash2, Pencil } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Accordion, AccordionItem, AccordionContent, AccordionTrigger } from '@/components/ui/accordion';
import type { CustomProviderConfig, CustomModelDef } from '@/lib/persistence/storage';
import { applyFetchedSelection, fetchRemoteModels } from '@/lib/providers/custom-models';
import { ModelList } from '@/components/settings/provider/ModelList';
import type { ModelFieldPatch } from '@/components/settings/provider/ModelListItem';
import { HeadersEditor, headerRowsToRecord, recordToHeaderRows, type HeaderRow } from '@/components/settings/HeadersEditor';
import { t } from '@/lib/i18n';

// ─── Shared form body (used by both create and edit) ───

interface ProviderFormFields {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: CustomModelDef[];
  headers: HeaderRow[];
  manualModelId: string;
  fetching: boolean;
  fetchError: string;
  /** 「自动获取」拿到的远端模型 id，等用户在弹窗里勾选；`null` = 弹窗未打开。 */
  pickerRemoteIds: string[] | null;
}

function ProviderFormBody({
  fields,
  onFieldChange,
  onFetchModels,
  onConfirmPicked,
  onCancelPick,
  onAddManualModel,
  onRemoveModels,
  onToggleReasoning,
  onToggleImage,
  onModelFieldChange,
  onSubmit,
  onCancel,
  submitLabel,
  submitDisabled,
}: {
  fields: ProviderFormFields;
  onFieldChange: (patch: Partial<ProviderFormFields>) => void;
  onFetchModels: () => void;
  onConfirmPicked: (selected: ReadonlySet<string>) => void;
  onCancelPick: () => void;
  onAddManualModel: () => void;
  onRemoveModels: (modelIds: string[]) => void;
  onToggleReasoning: (modelId: string) => void;
  onToggleImage: (modelId: string) => void;
  onModelFieldChange: (modelId: string, patch: ModelFieldPatch) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  submitDisabled: boolean;
}) {
  // 同时填了 API Key 与鉴权类 header（authorization / cf-aig-authorization）时提示：
  // pi-ai 会优先用 API Key（getClientApiKey），此时 header 不生效
  const authConflict = fields.apiKey.trim() !== '' &&
    fields.headers.some(h => {
      const k = h.key.trim().toLowerCase();
      return k === 'authorization' || k === 'cf-aig-authorization';
    });
  return (
    <div className="space-y-3 border border-border rounded-lg p-3">
      <div className="space-y-2">
        <Label className="text-xs">{t('provider.form.name')}</Label>
        <Input
          value={fields.name}
          onChange={e => onFieldChange({ name: e.target.value })}
          placeholder={t('provider.form.namePlaceholder')}
          className="h-8 text-sm"
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t('provider.form.baseUrl')}</Label>
        <Input
          value={fields.baseUrl}
          onChange={e => onFieldChange({ baseUrl: e.target.value })}
          placeholder={t('provider.form.baseUrlPlaceholder')}
          className="h-8 text-sm"
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t('provider.form.apiKeyOptional')}</Label>
        <PasswordInput
          value={fields.apiKey}
          onChange={e => onFieldChange({ apiKey: e.target.value })}
          placeholder={t('provider.form.apiKeyPlaceholder')}
          className="h-8 text-sm"
        />
      </div>

      <Separator />

      <ModelList
        models={fields.models}
        canFetch={fields.baseUrl.trim() !== ''}
        fetching={fields.fetching}
        fetchError={fields.fetchError}
        pickerRemoteIds={fields.pickerRemoteIds}
        manualModelId={fields.manualModelId}
        onManualModelIdChange={v => onFieldChange({ manualModelId: v })}
        onFetchModels={onFetchModels}
        onConfirmPicked={onConfirmPicked}
        onCancelPick={onCancelPick}
        onAddManualModel={onAddManualModel}
        onRemoveModels={onRemoveModels}
        onToggleReasoning={onToggleReasoning}
        onToggleImage={onToggleImage}
        onModelFieldChange={onModelFieldChange}
      />

      <Separator />

      {/* Advanced: custom request headers */}
      <Accordion type="single" collapsible>
        <AccordionItem value="advanced" className="border-0">
          <AccordionTrigger className="py-1 text-xs font-medium hover:no-underline">
            {t('provider.form.advanced')}
          </AccordionTrigger>
          <AccordionContent className="pb-1">
            <div className="space-y-2">
              <Label className="text-xs">{t('provider.form.headers')}</Label>
              <HeadersEditor rows={fields.headers} onChange={(headers) => onFieldChange({ headers })} />
              {authConflict && (
                <p className="text-xs text-amber-500">{t('provider.form.authOverrideHint')}</p>
              )}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

      <Separator />

      <div className="flex items-center gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          size="sm"
          onClick={onSubmit}
          disabled={submitDisabled}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

// ─── Shared form logic hook ───

function useProviderForm(initial?: { name: string; baseUrl: string; apiKey: string; models: CustomModelDef[]; headers?: Record<string, string> }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '');
  const [models, setModels] = useState<CustomModelDef[]>(initial?.models ?? []);
  const [headers, setHeaders] = useState<HeaderRow[]>(recordToHeaderRows(initial?.headers));
  const [manualModelId, setManualModelId] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [pickerRemoteIds, setPickerRemoteIds] = useState<string[] | null>(null);
  // 拉取代次：表单被重置 / 重新打开编辑、或端点参数变了，在途的拉取就作废——否则迟到的结果
  // 会在之后的表单里弹出上一个端点的模型勾选框（最长等 10 秒超时）。
  const fetchGenerationRef = useRef(0);
  const invalidateFetch = () => {
    fetchGenerationRef.current += 1;
    setFetching(false);
  };

  const fields: ProviderFormFields = { name, baseUrl, apiKey, models, headers, manualModelId, fetching, fetchError, pickerRemoteIds };

  const onFieldChange = (patch: Partial<ProviderFormFields>) => {
    if (patch.baseUrl !== undefined || patch.apiKey !== undefined || patch.headers !== undefined) invalidateFetch();
    if (patch.name !== undefined) setName(patch.name);
    if (patch.baseUrl !== undefined) setBaseUrl(patch.baseUrl);
    if (patch.apiKey !== undefined) setApiKey(patch.apiKey);
    if (patch.models !== undefined) setModels(patch.models);
    if (patch.headers !== undefined) setHeaders(patch.headers);
    if (patch.manualModelId !== undefined) setManualModelId(patch.manualModelId);
    if (patch.pickerRemoteIds !== undefined) setPickerRemoteIds(patch.pickerRemoteIds);
  };

  const handleFetchModels = async () => {
    if (!baseUrl.trim()) return;
    const generation = ++fetchGenerationRef.current;
    setFetching(true);
    setFetchError('');
    try {
      const remote = await fetchRemoteModels(baseUrl, apiKey, headerRowsToRecord(headers));
      if (generation !== fetchGenerationRef.current) return;
      // 不直接改列表：先让用户在弹窗里勾选（issue #86），确定时再按勾选合并
      setPickerRemoteIds([...new Set(remote.map(r => r.id))]);
      setFetchError('');
    } catch {
      if (generation !== fetchGenerationRef.current) return;
      setFetchError(t('provider.form.fetchFailed'));
    } finally {
      if (generation === fetchGenerationRef.current) setFetching(false);
    }
  };

  const handleConfirmPicked = (selected: ReadonlySet<string>) => {
    const remoteIds = pickerRemoteIds;
    setPickerRemoteIds(null);
    if (!remoteIds) return;
    // 按 modelId 合并：勾上的保留既有配置，不在这次获取结果里的（如手动添加的）不受影响
    setModels(prev => applyFetchedSelection(prev, remoteIds, selected));
  };

  const handleCancelPick = () => setPickerRemoteIds(null);

  const handleAddManualModel = () => {
    const id = manualModelId.trim();
    if (!id || models.some(m => m.modelId === id)) return;
    setModels([...models, { modelId: id, name: id, reasoning: false, image: false }]);
    setManualModelId('');
  };

  const handleRemoveModels = (modelIds: string[]) => {
    const removed = new Set(modelIds);
    setModels(prev => prev.filter(m => !removed.has(m.modelId)));
  };

  const handleToggleReasoning = (modelId: string) =>
    setModels(models.map(m => m.modelId === modelId ? { ...m, reasoning: !m.reasoning } : m));

  const handleToggleImage = (modelId: string) =>
    setModels(models.map(m => m.modelId === modelId ? { ...m, image: !m.image } : m));

  const handleModelFieldChange = (
    modelId: string,
    patch: ModelFieldPatch,
  ) => setModels(models.map(m => (m.modelId === modelId ? { ...m, ...patch } : m)));

  const reset = () => {
    setName('');
    setBaseUrl('');
    setApiKey('');
    setModels([]);
    setHeaders([]);
    setManualModelId('');
    setFetchError('');
    setPickerRemoteIds(null);
    invalidateFetch();
  };

  return { fields, onFieldChange, handleFetchModels, handleConfirmPicked, handleCancelPick, handleAddManualModel, handleRemoveModels, handleToggleReasoning, handleToggleImage, handleModelFieldChange, reset };
}

// ─── Create form ───

interface CustomProviderFormProps {
  onAdd: (config: CustomProviderConfig, apiKey?: string) => void;
}

export function CustomProviderForm({ onAdd }: CustomProviderFormProps) {
  const [expanded, setExpanded] = useState(false);
  const form = useProviderForm();

  const handleCancel = () => {
    form.reset();
    setExpanded(false);
  };

  const handleSubmit = () => {
    const { name, baseUrl, apiKey, models, headers } = form.fields;
    if (!name.trim() || !baseUrl.trim() || models.length === 0) return;

    // id 仅作内部存储 key（custom:<id>），不展示，用 uuid 保证唯一，
    // 避免纯中文等无 ASCII 字符的名称生成空 slug 导致添加静默失败。
    const id = crypto.randomUUID();
    const headerRecord = headerRowsToRecord(headers);

    onAdd({
      id,
      name: name.trim(),
      baseUrl: baseUrl.trim().replace(/\/+$/, ''),
      models,
      ...(headerRecord ? { headers: headerRecord } : {}),
    }, apiKey.trim() || undefined);

    form.reset();
    setExpanded(false);
  };

  if (!expanded) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => setExpanded(true)}
      >
        <Plus className="size-3.5" />
        {t('provider.form.addCustom')}
      </Button>
    );
  }

  return (
    <ProviderFormBody
      fields={form.fields}
      onFieldChange={form.onFieldChange}
      onFetchModels={form.handleFetchModels}
      onConfirmPicked={form.handleConfirmPicked}
      onCancelPick={form.handleCancelPick}
      onAddManualModel={form.handleAddManualModel}
      onRemoveModels={form.handleRemoveModels}
      onToggleReasoning={form.handleToggleReasoning}
      onToggleImage={form.handleToggleImage}
      onModelFieldChange={form.handleModelFieldChange}
      onSubmit={handleSubmit}
      onCancel={handleCancel}
      submitLabel={t('common.add')}
      submitDisabled={!form.fields.name.trim() || !form.fields.baseUrl.trim() || form.fields.models.length === 0}
    />
  );
}

// ─── Custom provider card (with inline edit) ───

interface CustomProviderCardProps {
  config: CustomProviderConfig;
  apiKey: string;
  onUpdate: (config: CustomProviderConfig, apiKey?: string) => void;
  onRemove: () => void;
}

export function CustomProviderCard({ config, apiKey, onUpdate, onRemove }: CustomProviderCardProps) {
  const [editing, setEditing] = useState(false);
  const form = useProviderForm({
    name: config.name,
    baseUrl: config.baseUrl,
    apiKey,
    models: config.models,
    headers: config.headers,
  });

  const openEdit = () => {
    // Re-init form from current props each time edit is opened
    form.onFieldChange({
      name: config.name,
      baseUrl: config.baseUrl,
      apiKey,
      models: config.models,
      headers: recordToHeaderRows(config.headers),
      manualModelId: '',
      pickerRemoteIds: null,
    });
    setEditing(true);
  };

  const handleCancel = () => {
    setEditing(false);
  };

  const handleSave = () => {
    const { name: newName, baseUrl, apiKey: newKey, models, headers } = form.fields;
    if (!newName.trim() || !baseUrl.trim() || models.length === 0) return;

    // Only pass apiKey if it was changed
    const keyChanged = newKey.trim() !== apiKey;

    onUpdate({
      ...config,
      name: newName.trim(),
      baseUrl: baseUrl.trim().replace(/\/+$/, ''),
      models,
      headers: headerRowsToRecord(headers),
    }, keyChanged ? (newKey.trim() || undefined) : apiKey || undefined);
    setEditing(false);
  };

  if (editing) {
    return (
      <ProviderFormBody
        fields={form.fields}
        onFieldChange={form.onFieldChange}
        onFetchModels={form.handleFetchModels}
        onConfirmPicked={form.handleConfirmPicked}
        onCancelPick={form.handleCancelPick}
        onAddManualModel={form.handleAddManualModel}
        onRemoveModels={form.handleRemoveModels}
        onToggleReasoning={form.handleToggleReasoning}
        onToggleImage={form.handleToggleImage}
        onModelFieldChange={form.handleModelFieldChange}
        onSubmit={handleSave}
        onCancel={handleCancel}
        submitLabel={t('common.save')}
        submitDisabled={!form.fields.name.trim() || !form.fields.baseUrl.trim() || form.fields.models.length === 0}
      />
    );
  }

  // 自定义 provider 不做连通性测试，只区分「已配置（淡蓝 info）/ 未配置（灰）」。
  // 用 header 鉴权（apiKey 留空）也算已配置，避免误显「未配置」
  const configured = !!apiKey || (!!config.headers && Object.keys(config.headers).length > 0);
  const badgeState = configured
    ? { label: t('provider.status.configured'), className: 'text-blue-500 border-blue-500/20 bg-blue-500/5' }
    : { label: t('provider.status.notConfigured'), className: 'text-muted-foreground border-border' };

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">{config.name}</p>
        <Badge
          variant="outline"
          className={`text-[0.65rem] h-4 px-1.5 ${badgeState.className}`}
        >
          {badgeState.label}
        </Badge>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={openEdit}
            title={t('common.edit')}
          >
            <Pencil className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={onRemove}
            title={t('common.delete')}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>
      <p className="text-[0.6rem] text-muted-foreground font-mono truncate">
        {config.baseUrl}
      </p>
    </div>
  );
}

import { useState, useRef } from 'react';
import { Plus, Trash2, RefreshCw, Pencil, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Separator } from '@/components/ui/separator';
import { Accordion, AccordionItem, AccordionContent, AccordionTrigger } from '@/components/ui/accordion';
import type { CustomProviderConfig, CustomModelDef } from '@/lib/persistence/storage';
import { fetchRemoteModels, mergeFetchedModels } from '@/lib/providers/custom-models';
import { ModelListItem } from '@/components/settings/provider/ModelListItem';
import { HeadersEditor, headerRowsToRecord, recordToHeaderRows, type HeaderRow } from '@/components/settings/HeadersEditor';
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
}: {
  value: string;
  onChange: (v: string) => void;
  onAdd: () => void;
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
      <Button variant="outline" size="sm" className="w-full" onClick={open}>
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
}

function ProviderFormBody({
  fields,
  onFieldChange,
  onFetchModels,
  onAddManualModel,
  onRemoveModel,
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
  onAddManualModel: () => void;
  onRemoveModel: (modelId: string) => void;
  onToggleReasoning: (modelId: string) => void;
  onToggleImage: (modelId: string) => void;
  onModelFieldChange: (modelId: string, patch: Partial<Pick<CustomModelDef, 'contextWindow' | 'maxTokens'>>) => void;
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

      {/* Fetch models */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs">{t('provider.form.models')}</Label>
          <Button
            variant="ghost"
            size="xs"
            onClick={onFetchModels}
            disabled={fields.fetching || !fields.baseUrl.trim()}
          >
            {fields.fetching ? <Spinner className="size-3" /> : <RefreshCw className="size-3" />}
            {t('provider.form.autoFetch')}
          </Button>
        </div>

        {fields.fetchError && (
          <p className="text-xs text-destructive">{fields.fetchError}</p>
        )}

        {/* Model list */}
        {fields.models.length > 0 && (
          <Accordion type="multiple" className="divide-y divide-border/50">
            {fields.models.map(m => (
              <ModelListItem
                key={m.modelId}
                model={m}
                onToggleReasoning={onToggleReasoning}
                onToggleImage={onToggleImage}
                onRemove={onRemoveModel}
                onFieldChange={onModelFieldChange}
              />
            ))}
          </Accordion>
        )}

        {/* Manual add */}
        <ManualAddModel
          value={fields.manualModelId}
          onChange={v => onFieldChange({ manualModelId: v })}
          onAdd={onAddManualModel}
        />
      </div>

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

  const fields: ProviderFormFields = { name, baseUrl, apiKey, models, headers, manualModelId, fetching, fetchError };

  const onFieldChange = (patch: Partial<ProviderFormFields>) => {
    if (patch.name !== undefined) setName(patch.name);
    if (patch.baseUrl !== undefined) setBaseUrl(patch.baseUrl);
    if (patch.apiKey !== undefined) setApiKey(patch.apiKey);
    if (patch.models !== undefined) setModels(patch.models);
    if (patch.headers !== undefined) setHeaders(patch.headers);
    if (patch.manualModelId !== undefined) setManualModelId(patch.manualModelId);
  };

  const handleFetchModels = async () => {
    if (!baseUrl.trim()) return;
    setFetching(true);
    setFetchError('');
    try {
      const remote = await fetchRemoteModels(baseUrl, apiKey, headerRowsToRecord(headers));
      // 按 modelId 合并，保留用户已设过的每模型配置，不因重新获取而清空
      setModels(prev => mergeFetchedModels(prev, remote.map(r => r.id)));
      setFetchError('');
    } catch {
      setFetchError(t('provider.form.fetchFailed'));
    } finally {
      setFetching(false);
    }
  };

  const handleAddManualModel = () => {
    const id = manualModelId.trim();
    if (!id || models.some(m => m.modelId === id)) return;
    setModels([...models, { modelId: id, name: id, reasoning: false, image: false }]);
    setManualModelId('');
  };

  const handleRemoveModel = (modelId: string) => setModels(models.filter(m => m.modelId !== modelId));

  const handleToggleReasoning = (modelId: string) =>
    setModels(models.map(m => m.modelId === modelId ? { ...m, reasoning: !m.reasoning } : m));

  const handleToggleImage = (modelId: string) =>
    setModels(models.map(m => m.modelId === modelId ? { ...m, image: !m.image } : m));

  const handleModelFieldChange = (
    modelId: string,
    patch: Partial<Pick<CustomModelDef, 'contextWindow' | 'maxTokens'>>,
  ) => setModels(models.map(m => (m.modelId === modelId ? { ...m, ...patch } : m)));

  const reset = () => {
    setName('');
    setBaseUrl('');
    setApiKey('');
    setModels([]);
    setHeaders([]);
    setManualModelId('');
    setFetchError('');
  };

  return { fields, onFieldChange, handleFetchModels, handleAddManualModel, handleRemoveModel, handleToggleReasoning, handleToggleImage, handleModelFieldChange, reset };
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
      onAddManualModel={form.handleAddManualModel}
      onRemoveModel={form.handleRemoveModel}
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
        onAddManualModel={form.handleAddManualModel}
        onRemoveModel={form.handleRemoveModel}
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

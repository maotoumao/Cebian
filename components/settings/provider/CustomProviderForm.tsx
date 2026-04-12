import { useState } from 'react';
import { Plus, Trash2, RefreshCw, Pencil } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import type { CustomProviderConfig, CustomModelDef } from '@/lib/storage';
import { fetchRemoteModels } from '@/lib/custom-models';

// ─── Shared form body (used by both create and edit) ───

interface ProviderFormFields {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: CustomModelDef[];
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
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  submitDisabled: boolean;
}) {
  return (
    <div className="space-y-3 border border-border rounded-lg p-3">
      <div className="space-y-2">
        <Label className="text-xs">名称</Label>
        <Input
          value={fields.name}
          onChange={e => onFieldChange({ name: e.target.value })}
          placeholder="例如：My Ollama"
          className="h-8 text-sm"
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs">Base URL</Label>
        <Input
          value={fields.baseUrl}
          onChange={e => onFieldChange({ baseUrl: e.target.value })}
          placeholder="例如：http://localhost:11434/v1"
          className="h-8 text-sm"
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs">API Key（可选）</Label>
        <Input
          type="password"
          value={fields.apiKey}
          onChange={e => onFieldChange({ apiKey: e.target.value })}
          placeholder="留空则不传认证"
          className="h-8 text-sm"
        />
      </div>

      <Separator />

      {/* Fetch models */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs">模型列表</Label>
          <Button
            variant="ghost"
            size="xs"
            onClick={onFetchModels}
            disabled={fields.fetching || !fields.baseUrl.trim()}
          >
            {fields.fetching ? <Spinner className="size-3" /> : <RefreshCw className="size-3" />}
            自动获取
          </Button>
        </div>

        {fields.fetchError && (
          <p className="text-xs text-destructive">{fields.fetchError}</p>
        )}

        {/* Model list */}
        {fields.models.length > 0 && (
          <div className="space-y-1.5 max-h-40 overflow-y-auto">
            {fields.models.map(m => (
              <div key={m.modelId} className="flex items-center gap-2 text-xs">
                <span className="flex-1 font-mono truncate">{m.modelId}</span>
                <div className="flex items-center gap-1">
                  <Label className="text-[0.6rem] text-muted-foreground">推理</Label>
                  <Switch
                    checked={m.reasoning}
                    onCheckedChange={() => onToggleReasoning(m.modelId)}
                    className="scale-75"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-destructive hover:text-destructive"
                  onClick={() => onRemoveModel(m.modelId)}
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Manual add */}
        <div className="flex items-center gap-2">
          <Input
            value={fields.manualModelId}
            onChange={e => onFieldChange({ manualModelId: e.target.value })}
            onKeyDown={e => e.key === 'Enter' && onAddManualModel()}
            placeholder="手动输入 Model ID"
            className="h-7 text-xs flex-1"
          />
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onAddManualModel}
            disabled={!fields.manualModelId.trim()}
          >
            <Plus className="size-3" />
          </Button>
        </div>
      </div>

      <Separator />

      <div className="flex items-center gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          取消
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

function useProviderForm(initial?: { name: string; baseUrl: string; apiKey: string; models: CustomModelDef[] }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '');
  const [models, setModels] = useState<CustomModelDef[]>(initial?.models ?? []);
  const [manualModelId, setManualModelId] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');

  const fields: ProviderFormFields = { name, baseUrl, apiKey, models, manualModelId, fetching, fetchError };

  const onFieldChange = (patch: Partial<ProviderFormFields>) => {
    if (patch.name !== undefined) setName(patch.name);
    if (patch.baseUrl !== undefined) setBaseUrl(patch.baseUrl);
    if (patch.apiKey !== undefined) setApiKey(patch.apiKey);
    if (patch.models !== undefined) setModels(patch.models);
    if (patch.manualModelId !== undefined) setManualModelId(patch.manualModelId);
  };

  const handleFetchModels = async () => {
    if (!baseUrl.trim()) return;
    setFetching(true);
    setFetchError('');
    try {
      const remote = await fetchRemoteModels(baseUrl, apiKey);
      setModels(remote.map(m => ({ modelId: m.id, name: m.id, reasoning: false })));
      setFetchError('');
    } catch {
      setFetchError('无法获取模型列表，请手动添加');
    } finally {
      setFetching(false);
    }
  };

  const handleAddManualModel = () => {
    const id = manualModelId.trim();
    if (!id || models.some(m => m.modelId === id)) return;
    setModels([...models, { modelId: id, name: id, reasoning: false }]);
    setManualModelId('');
  };

  const handleRemoveModel = (modelId: string) => setModels(models.filter(m => m.modelId !== modelId));

  const handleToggleReasoning = (modelId: string) =>
    setModels(models.map(m => m.modelId === modelId ? { ...m, reasoning: !m.reasoning } : m));

  const reset = () => {
    setName('');
    setBaseUrl('');
    setApiKey('');
    setModels([]);
    setManualModelId('');
    setFetchError('');
  };

  return { fields, onFieldChange, handleFetchModels, handleAddManualModel, handleRemoveModel, handleToggleReasoning, reset };
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
    const { name, baseUrl, apiKey, models } = form.fields;
    if (!name.trim() || !baseUrl.trim() || models.length === 0) return;

    const id = name.trim().toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!id) return;

    onAdd({
      id,
      name: name.trim(),
      baseUrl: baseUrl.trim().replace(/\/+$/, ''),
      models,
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
        添加自定义提供商
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
      onSubmit={handleSubmit}
      onCancel={handleCancel}
      submitLabel="添加"
      submitDisabled={!form.fields.name.trim() || !form.fields.baseUrl.trim() || form.fields.models.length === 0}
    />
  );
}

// ─── Custom provider card (with inline edit) ───

interface CustomProviderCardProps {
  config: CustomProviderConfig;
  apiKey: string;
  verified: boolean;
  onUpdate: (config: CustomProviderConfig, apiKey?: string) => void;
  onRemove: () => void;
}

export function CustomProviderCard({ config, apiKey, verified, onUpdate, onRemove }: CustomProviderCardProps) {
  const [editing, setEditing] = useState(false);
  const form = useProviderForm({
    name: config.name,
    baseUrl: config.baseUrl,
    apiKey,
    models: config.models,
  });

  const openEdit = () => {
    // Re-init form from current props each time edit is opened
    form.onFieldChange({
      name: config.name,
      baseUrl: config.baseUrl,
      apiKey,
      models: config.models,
      manualModelId: '',
    });
    setEditing(true);
  };

  const handleCancel = () => {
    setEditing(false);
  };

  const handleSave = () => {
    const { name: newName, baseUrl, apiKey: newKey, models } = form.fields;
    if (!newName.trim() || !baseUrl.trim() || models.length === 0) return;

    // Only pass apiKey if it was changed
    const keyChanged = newKey.trim() !== apiKey;

    onUpdate({
      ...config,
      name: newName.trim(),
      baseUrl: baseUrl.trim().replace(/\/+$/, ''),
      models,
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
        onSubmit={handleSave}
        onCancel={handleCancel}
        submitLabel="保存"
        submitDisabled={!form.fields.name.trim() || !form.fields.baseUrl.trim() || form.fields.models.length === 0}
      />
    );
  }

  const badgeState = verified
    ? { label: '已连接', className: 'text-success border-success/20 bg-success/5' }
    : apiKey
      ? { label: '未验证', className: 'text-yellow-500 border-yellow-500/20 bg-yellow-500/5' }
      : { label: '未配置', className: 'text-muted-foreground border-border' };

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
            title="编辑"
          >
            <Pencil className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={onRemove}
            title="删除"
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

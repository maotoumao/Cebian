import { useState } from 'react';
import { Plus, Trash2, RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import type { CustomProviderConfig, CustomModelDef } from '@/lib/storage';
import { fetchRemoteModels } from '@/lib/custom-models';

interface CustomProviderFormProps {
  onAdd: (config: CustomProviderConfig) => void;
}

export function CustomProviderForm({ onAdd }: CustomProviderFormProps) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<CustomModelDef[]>([]);
  const [manualModelId, setManualModelId] = useState('');
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');

  const reset = () => {
    setName('');
    setBaseUrl('');
    setApiKey('');
    setModels([]);
    setManualModelId('');
    setFetchError('');
    setExpanded(false);
  };

  const handleFetchModels = async () => {
    if (!baseUrl.trim() || !apiKey.trim()) return;

    setFetching(true);
    setFetchError('');

    try {
      const remote = await fetchRemoteModels(baseUrl, apiKey);
      const newModels: CustomModelDef[] = remote.map(m => ({
        modelId: m.id,
        name: m.id,
        reasoning: false,
      }));
      setModels(newModels);
      setFetchError('');
    } catch {
      setModels([]);
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

  const handleRemoveModel = (modelId: string) => {
    setModels(models.filter(m => m.modelId !== modelId));
  };

  const handleToggleReasoning = (modelId: string) => {
    setModels(models.map(m =>
      m.modelId === modelId ? { ...m, reasoning: !m.reasoning } : m,
    ));
  };

  const handleSubmit = () => {
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
    });
    reset();
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
    <div className="space-y-3 border border-border rounded-lg p-3">
      <div className="space-y-2">
        <Label className="text-xs">名称</Label>
        <Input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="例如：My Ollama"
          className="h-8 text-sm"
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs">Base URL</Label>
        <Input
          value={baseUrl}
          onChange={e => setBaseUrl(e.target.value)}
          placeholder="例如：http://localhost:11434/v1"
          className="h-8 text-sm"
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs">API Key（可选）</Label>
        <Input
          type="password"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
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
            onClick={handleFetchModels}
            disabled={fetching || !baseUrl.trim()}
          >
            {fetching ? <Spinner className="size-3" /> : <RefreshCw className="size-3" />}
            自动获取
          </Button>
        </div>

        {fetchError && (
          <p className="text-xs text-destructive">{fetchError}</p>
        )}

        {/* Model list */}
        {models.length > 0 && (
          <div className="space-y-1.5 max-h-40 overflow-y-auto">
            {models.map(m => (
              <div key={m.modelId} className="flex items-center gap-2 text-xs">
                <span className="flex-1 font-mono truncate">{m.modelId}</span>
                <div className="flex items-center gap-1">
                  <Label className="text-[0.6rem] text-muted-foreground">推理</Label>
                  <Switch
                    checked={m.reasoning}
                    onCheckedChange={() => handleToggleReasoning(m.modelId)}
                    className="scale-75"
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-destructive hover:text-destructive"
                  onClick={() => handleRemoveModel(m.modelId)}
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
            value={manualModelId}
            onChange={e => setManualModelId(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAddManualModel()}
            placeholder="手动输入 Model ID"
            className="h-7 text-xs flex-1"
          />
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleAddManualModel}
            disabled={!manualModelId.trim()}
          >
            <Plus className="size-3" />
          </Button>
        </div>
      </div>

      <Separator />

      <div className="flex items-center gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={reset}>
          取消
        </Button>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!name.trim() || !baseUrl.trim() || models.length === 0}
        >
          添加
        </Button>
      </div>
    </div>
  );
}

// ─── Existing custom provider card ───

interface CustomProviderCardProps {
  config: CustomProviderConfig;
  verified: boolean;
  onRemove: () => void;
}

export function CustomProviderCard({ config, verified, onRemove }: CustomProviderCardProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">{config.name}</p>
        <Badge
          variant="outline"
          className={`text-[0.65rem] h-4 px-1.5 ${
            verified
              ? 'text-success border-success/20 bg-success/5'
              : 'text-muted-foreground border-border'
          }`}
        >
          {verified ? '已连接' : '未配置'}
        </Badge>
        <span className="text-[0.6rem] text-muted-foreground font-mono ml-auto truncate max-w-32">
          {config.baseUrl}
        </span>
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
      <p className="text-[0.65rem] text-muted-foreground">
        {config.models.map(m => m.name || m.modelId).join(', ')}
      </p>
    </div>
  );
}

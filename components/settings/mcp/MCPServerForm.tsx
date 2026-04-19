import { useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import type { MCPAuthConfig, MCPServerConfig, MCPTransportConfig } from '@/lib/storage';
import { addMCPServer, updateMCPServer } from '@/lib/mcp/store';
import { t } from '@/lib/i18n';

// ─── Form state ───

type TransportType = MCPTransportConfig['type'];
type AuthType = MCPAuthConfig['type'];

export interface MCPFormValues {
  name: string;
  transportType: TransportType;
  url: string;
  authType: AuthType;
  bearerToken: string;
}

const EMPTY: MCPFormValues = {
  name: '',
  transportType: 'streamable-http',
  url: '',
  authType: 'none',
  bearerToken: '',
};

/**
 * Build a store-shaped input from form values. Throws on missing required
 * fields. The store layer (`validateAndNormalize`) does final URL/auth checks.
 */
export function formToInput(values: MCPFormValues): {
  name: string;
  transport: MCPTransportConfig;
  auth: MCPAuthConfig;
} {
  const auth: MCPAuthConfig = values.authType === 'bearer'
    ? { type: 'bearer', token: values.bearerToken.trim() }
    : { type: 'none' };
  return {
    name: values.name.trim(),
    transport: { type: values.transportType, url: values.url.trim() },
    auth,
  };
}

// ─── Shared form body ───

interface FormBodyProps {
  values: MCPFormValues;
  onChange: (patch: Partial<MCPFormValues>) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  submitDisabled: boolean;
}

export function MCPFormBody({
  values,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
  submitDisabled,
}: FormBodyProps) {
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !submitDisabled) {
      e.preventDefault();
      onSubmit();
    }
  };
  return (
    <div className="space-y-3 border border-border rounded-lg p-3">
      <div className="space-y-2">
        <Label className="text-xs">{t('settings.mcp.form.name')}</Label>
        <Input
          value={values.name}
          onChange={(e) => onChange({ name: e.target.value })}
          onKeyDown={onEnter}
          placeholder={t('settings.mcp.form.namePlaceholder')}
          className="h-8 text-sm"
        />
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t('settings.mcp.form.transport')}</Label>
        <div className="flex gap-1">
          {(['streamable-http', 'sse'] as const).map((tt) => {
            const active = values.transportType === tt;
            return (
              <Button
                key={tt}
                type="button"
                variant={active ? 'default' : 'outline'}
                size="xs"
                className={active ? 'border border-transparent' : undefined}
                onClick={() => onChange({ transportType: tt })}
              >
                {tt}
              </Button>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">{t('settings.mcp.form.url')}</Label>
        <Input
          value={values.url}
          onChange={(e) => onChange({ url: e.target.value })}
          onKeyDown={onEnter}
          placeholder={t('settings.mcp.form.urlPlaceholder')}
          className="h-8 text-sm font-mono"
        />
      </div>

      <Separator />

      <div className="space-y-2">
        <Label className="text-xs">{t('settings.mcp.form.authType')}</Label>
        <div className="flex gap-1">
          <Button
            type="button"
            variant={values.authType === 'none' ? 'default' : 'outline'}
            size="xs"
            className={values.authType === 'none' ? 'border border-transparent' : undefined}
            onClick={() => onChange({ authType: 'none' })}
          >
            {t('settings.mcp.form.authNone')}
          </Button>
          <Button
            type="button"
            variant={values.authType === 'bearer' ? 'default' : 'outline'}
            size="xs"
            className={values.authType === 'bearer' ? 'border border-transparent' : undefined}
            onClick={() => onChange({ authType: 'bearer' })}
          >
            {t('settings.mcp.form.authBearer')}
          </Button>
        </div>
      </div>

      {values.authType === 'bearer' && (
        <div className="space-y-2">
          <Label className="text-xs">{t('settings.mcp.form.bearerToken')}</Label>
          <Input
            type="password"
            value={values.bearerToken}
            onChange={(e) => onChange({ bearerToken: e.target.value })}
            onKeyDown={onEnter}
            placeholder={t('settings.mcp.form.bearerTokenPlaceholder')}
            className="h-8 text-sm font-mono"
          />
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button type="button" size="sm" onClick={onSubmit} disabled={submitDisabled}>{submitLabel}</Button>
      </div>
    </div>
  );
}

// ─── Add server: collapsed button → expanded form ───

export function MCPServerAddForm() {
  const [expanded, setExpanded] = useState(false);
  const [values, setValues] = useState<MCPFormValues>(EMPTY);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setValues(EMPTY);
    setExpanded(false);
  };

  const handleSubmit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await addMCPServer(formToInput(values));
      reset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!expanded) {
    return (
      <Button variant="outline" size="sm" className="w-full" onClick={() => setExpanded(true)}>
        <Plus className="size-3.5" />
        {t('settings.mcp.actions.add')}
      </Button>
    );
  }

  const submitDisabled = busy
    || !values.name.trim()
    || !values.url.trim()
    || (values.authType === 'bearer' && !values.bearerToken.trim());

  return (
    <MCPFormBody
      values={values}
      onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
      onSubmit={handleSubmit}
      onCancel={reset}
      submitLabel={t('common.add')}
      submitDisabled={submitDisabled}
    />
  );
}

// ─── Edit existing server ───

function configToValues(server: MCPServerConfig): MCPFormValues {
  return {
    name: server.name,
    transportType: server.transport.type,
    url: server.transport.url,
    authType: server.auth.type,
    bearerToken: server.auth.type === 'bearer' ? server.auth.token : '',
  };
}

interface MCPServerEditFormProps {
  server: MCPServerConfig;
  onDone: () => void;
}

export function MCPServerEditForm({ server, onDone }: MCPServerEditFormProps) {
  const [values, setValues] = useState<MCPFormValues>(() => configToValues(server));
  const [busy, setBusy] = useState(false);

  const handleSubmit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const input = formToInput(values);
      await updateMCPServer(server.id, {
        name: input.name,
        transport: input.transport,
        auth: input.auth,
      });
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitDisabled = busy
    || !values.name.trim()
    || !values.url.trim()
    || (values.authType === 'bearer' && !values.bearerToken.trim());

  return (
    <MCPFormBody
      values={values}
      onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
      onSubmit={handleSubmit}
      onCancel={onDone}
      submitLabel={t('common.save')}
      submitDisabled={submitDisabled}
    />
  );
}

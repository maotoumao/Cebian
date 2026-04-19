import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
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
  /**
   * Headers as an editable array; rows may temporarily have empty keys/values
   * while the user is typing. `formToInput` aggregates them into the storage
   * `Record<string, string>` shape (case-insensitive, last-write-wins) and
   * silently drops rows with empty keys.
   */
  headers: Array<{ key: string; value: string }>;
}

const makeEmpty = (): MCPFormValues => ({
  name: '',
  transportType: 'streamable-http',
  url: '',
  authType: 'none',
  bearerToken: '',
  headers: [],
});

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

  // Aggregate header rows: skip empty keys, normalize via Headers (case-
  // insensitive, last write wins). Only attach `headers` when non-empty so
  // the stored record stays minimal.
  let headers: Record<string, string> | undefined;
  if (values.headers.length > 0) {
    const h = new Headers();
    for (const row of values.headers) {
      const k = row.key.trim();
      if (!k) continue;
      h.set(k, row.value);
    }
    const out: Record<string, string> = {};
    h.forEach((v, k) => { out[k] = v; });
    if (Object.keys(out).length > 0) headers = out;
  }

  const transport: MCPTransportConfig = {
    type: values.transportType,
    url: values.url.trim(),
    ...(headers ? { headers } : {}),
  };
  return { name: values.name.trim(), transport, auth };
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
  // Header rows: Enter must NOT submit (user is mid-edit, multi-row).
  const onHeaderKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.preventDefault();
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

      <Separator />

      <div className="space-y-2">
        <Label className="text-xs">{t('settings.mcp.form.headers')}</Label>
        {values.headers.length > 0 && (
          <div className="space-y-1">
            {values.headers.map((row, idx) => (
              <div key={idx} className="flex items-center gap-1">
                <Input
                  value={row.key}
                  onChange={(e) => {
                    const next = values.headers.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r));
                    onChange({ headers: next });
                  }}
                  onKeyDown={onHeaderKeyDown}
                  placeholder={t('settings.mcp.form.headerKeyPlaceholder')}
                  className="h-8 text-sm font-mono flex-1"
                />
                <Input
                  value={row.value}
                  onChange={(e) => {
                    const next = values.headers.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r));
                    onChange({ headers: next });
                  }}
                  onKeyDown={onHeaderKeyDown}
                  placeholder={t('settings.mcp.form.headerValuePlaceholder')}
                  className="h-8 text-sm font-mono flex-1"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => onChange({ headers: values.headers.filter((_, i) => i !== idx) })}
                  aria-label={t('settings.mcp.form.removeHeader')}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="w-full"
          onClick={() => onChange({ headers: [...values.headers, { key: '', value: '' }] })}
        >
          <Plus className="size-3.5" />
          {t('settings.mcp.form.addHeader')}
        </Button>
      </div>

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
  const [values, setValues] = useState<MCPFormValues>(makeEmpty);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setValues(makeEmpty());
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
  const headerRows = server.transport.headers
    ? Object.entries(server.transport.headers).map(([key, value]) => ({ key, value }))
    : [];
  return {
    name: server.name,
    transportType: server.transport.type,
    url: server.transport.url,
    authType: server.auth.type,
    bearerToken: server.auth.type === 'bearer' ? server.auth.token : '',
    headers: headerRows,
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

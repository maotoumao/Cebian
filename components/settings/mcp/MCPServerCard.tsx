import { useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { MCPServerConfig } from '@/lib/storage';
import { setMCPServerEnabled, removeMCPServer } from '@/lib/mcp/store';
import { MCPServerEditForm } from './MCPServerForm';
import { useMCPStatus, type MCPStatusInfo } from '@/hooks/useMCPStatus';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

interface MCPServerCardProps {
  server: MCPServerConfig;
}

interface StatusDotMeta {
  className: string;
  label: string;
}

function getStatusDot(server: MCPServerConfig, info: MCPStatusInfo | undefined): StatusDotMeta {
  if (!server.enabled) {
    return { className: 'bg-muted-foreground/30', label: t('settings.mcp.status.disabled') };
  }
  if (!info) {
    return { className: 'bg-muted-foreground/40', label: t('settings.mcp.status.idle') };
  }
  if (info.breaker === 'OPEN') {
    return { className: 'bg-red-500', label: t('settings.mcp.status.circuitOpen') };
  }
  if (info.breaker === 'HALF_OPEN') {
    return { className: 'bg-amber-500', label: t('settings.mcp.status.probing') };
  }
  if (info.connected) {
    return { className: 'bg-emerald-500', label: t('settings.mcp.status.connected') };
  }
  return { className: 'bg-muted-foreground/40', label: t('settings.mcp.status.disconnected') };
}

/**
 * MCPServerCard — summary of one MCP server with enable/edit/delete actions.
 * Click the pencil icon to expand into an inline edit form.
 */
export function MCPServerCard({ server }: MCPServerCardProps) {
  const [editing, setEditing] = useState(false);
  const statusMap = useMCPStatus();
  const dot = getStatusDot(server, statusMap[server.id]);

  const handleToggle = async (enabled: boolean) => {
    try {
      await setMCPServerEnabled(server.id, enabled);
    } catch (err) {
      console.error('[mcp] failed to toggle server:', err);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async () => {
    if (!confirm(t('settings.mcp.actions.deleteConfirm', [server.name]))) return;
    try {
      await removeMCPServer(server.id);
    } catch (err) {
      console.error('[mcp] failed to remove server:', err);
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  if (editing) {
    return <MCPServerEditForm server={server} onDone={() => setEditing(false)} />;
  }

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            role="img"
            className={cn('size-2 rounded-full shrink-0', dot.className)}
            title={dot.label}
            aria-label={dot.label}
          />
          <span className="text-sm font-medium truncate">{server.name}</span>
          <Badge variant="outline" className="text-[10px] uppercase tracking-wide shrink-0">
            {server.transport.type}
          </Badge>
          {!server.enabled && (
            <Badge variant="secondary" className="text-[10px] shrink-0">
              {t('settings.mcp.status.disabled')}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Switch
            checked={server.enabled}
            onCheckedChange={handleToggle}
            aria-label={t('settings.mcp.actions.toggle')}
          />
          <div className="h-4 w-px bg-border mx-1" aria-hidden />
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-foreground"
            onClick={() => setEditing(true)}
            aria-label={t('settings.mcp.actions.edit')}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-destructive"
            onClick={handleDelete}
            aria-label={t('settings.mcp.actions.delete')}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground font-mono truncate" title={server.transport.url}>
        {server.transport.url}
      </p>
    </div>
  );
}

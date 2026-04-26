import { useStorageItem } from '@/hooks/useStorageItem';
import { mcpServers } from '@/lib/storage';
import { MCPServerCard } from '@/components/settings/mcp/MCPServerCard';
import { MCPServerAddForm } from '@/components/settings/mcp/MCPServerForm';
import { t } from '@/lib/i18n';

/**
 * MCPSection — manage MCP server configurations.
 *
 * v1: list / add / edit / enable / disable / delete servers.
 * Connection lifecycle is handled by the background `MCPManager`; this
 * section only edits storage and reads status.
 */
export function MCPSection() {
  const [servers] = useStorageItem(mcpServers, []);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t('settings.mcp.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('settings.mcp.description')}</p>
      </div>

      {servers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-sm text-muted-foreground">{t('settings.mcp.empty.title')}</p>
          <p className="text-xs text-muted-foreground mt-1">{t('settings.mcp.empty.hint')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {servers.map((s) => (
            <MCPServerCard key={s.id} server={s} />
          ))}
        </div>
      )}

      <MCPServerAddForm />
    </div>
  );
}

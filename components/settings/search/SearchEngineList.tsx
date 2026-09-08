import { useState } from 'react';
import { AlertTriangle, ChevronRight, ChevronUp, ChevronDown, Ellipsis, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { searchEngineHost, type ResolvedSearchEngine } from '@/lib/search/engines';
import { t } from '@/lib/i18n';

interface SearchEngineListProps {
  /** 全部引擎（含停用的），已按回退顺序。 */
  engines: ResolvedSearchEngine[];
  onToggle: (id: string, enabled: boolean) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onReset: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
  onCreate: () => void;
}

/** 名称旁的小标签（首选 / 自定义 / 已修改）：复用 Badge，只调尺寸与配色。 */
function Tag({ children, accent = false }: { children: string; accent?: boolean }) {
  return (
    <Badge
      variant="outline"
      className={
        accent
          ? 'h-[17px] px-1.5 text-[10.5px] border-transparent bg-primary/10 text-primary'
          : 'h-[17px] px-1.5 text-[10.5px] bg-muted text-muted-foreground'
      }
    >
      {children}
    </Badge>
  );
}

/**
 * 搜索引擎列表：序号即回退顺序，第一个开着的标「首选」。默认态突出名称、域名与启用状态，
 * 编辑入口占据主要点击区域；低频的调序 / 恢复默认 / 删除收进更多菜单，避免窄侧栏里出现
 * 密集的小按钮（与划词工具条动作列表同一布局）。
 */
export function SearchEngineList({ engines, onToggle, onMove, onReset, onDelete, onEdit, onCreate }: SearchEngineListProps) {
  const [pendingDelete, setPendingDelete] = useState<ResolvedSearchEngine | null>(null);
  const preferredId = engines.find((e) => e.enabled)?.id;

  return (
    <div className="flex flex-col gap-2">
      {preferredId === undefined && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{t('settings.chat.search.allDisabled')}</span>
        </div>
      )}

      <ul className="divide-y overflow-hidden rounded-md border border-border">
        {engines.map((engine, index) => {
          const host = searchEngineHost(engine.urlTemplate) ?? engine.urlTemplate;
          return (
            <li key={engine.id} className="flex min-h-12 items-center gap-1 px-1">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-2 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                onClick={() => onEdit(engine.id)}
                aria-label={t('settings.chat.search.edit', [engine.name])}
              >
                <span className="w-4 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{index + 1}</span>
                <span className={engine.enabled ? 'min-w-0 flex-1' : 'min-w-0 flex-1 opacity-50'}>
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{engine.name}</span>
                    {engine.id === preferredId && <Tag accent>{t('settings.chat.search.preferred')}</Tag>}
                    {engine.kind === 'custom' && <Tag>{t('settings.chat.search.custom')}</Tag>}
                    {engine.modified && <Tag>{t('settings.chat.search.modified')}</Tag>}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {host}
                    {engine.when ? ` · ${engine.when}` : ''}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </button>

              <Switch
                checked={engine.enabled}
                onCheckedChange={(v) => onToggle(engine.id, v)}
                className="shrink-0"
                aria-label={engine.name}
              />

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground"
                    aria-label={t('settings.chat.search.more', [engine.name])}
                  >
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56 max-w-[calc(100vw-1rem)]">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onSelect={() => onEdit(engine.id)}>
                      <Pencil />
                      <span className="min-w-0 break-words">{t('settings.chat.search.edit', [engine.name])}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={index === 0} onSelect={() => onMove(engine.id, -1)}>
                      <ChevronUp />
                      <span className="min-w-0 break-words">{t('settings.chat.search.moveUp', [engine.name])}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={index === engines.length - 1} onSelect={() => onMove(engine.id, 1)}>
                      <ChevronDown />
                      <span className="min-w-0 break-words">{t('settings.chat.search.moveDown', [engine.name])}</span>
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    {engine.kind === 'builtin' ? (
                      <DropdownMenuItem disabled={!engine.modified} onSelect={() => onReset(engine.id)}>
                        <RotateCcw />
                        <span className="min-w-0 break-words">{t('settings.chat.search.resetDefault', [engine.name])}</span>
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem variant="destructive" onSelect={() => setPendingDelete(engine)}>
                        <Trash2 />
                        <span className="min-w-0 break-words">{t('settings.chat.search.delete', [engine.name])}</span>
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
      </ul>

      <Button type="button" variant="outline" size="sm" className="w-full" onClick={onCreate}>
        <Plus className="size-3.5" />
        {t('settings.chat.search.create')}
      </Button>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings.chat.search.deleteConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete ? t('settings.chat.search.deleteConfirmDescription', [pendingDelete.name]) : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDelete) onDelete(pendingDelete.id);
              }}
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

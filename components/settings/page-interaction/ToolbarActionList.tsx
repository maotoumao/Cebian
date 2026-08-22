import { useState } from 'react';
import { ChevronRight, ChevronUp, ChevronDown, Ellipsis, Pencil, Plus, Trash2 } from 'lucide-react';
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
import type { ResolvedPageAction } from '@/lib/page-actions/actions';
import { isUnrestrictedPageScope } from '@/lib/page-actions/match';
import { t } from '@/lib/i18n';

interface ToolbarActionListProps {
  /** 全部动作（含被关掉的），已按工具条顺序。 */
  actions: ResolvedPageAction[];
  onToggle: (id: string, enabled: boolean) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
  onCreate: () => void;
}

/**
 * 工具条动作列表：默认态突出名称、范围与启用状态，编辑入口占据主要点击区域
 * 低频的调序与删除收进更多菜单，避免窄侧栏里出现密集的小按钮
 */
export function ToolbarActionList({
  actions,
  onToggle,
  onMove,
  onDelete,
  onEdit,
  onCreate,
}: ToolbarActionListProps) {
  const [pendingDelete, setPendingDelete] = useState<ResolvedPageAction | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-y overflow-hidden rounded-md border border-border">
        {actions.map((action, index) => (
          <li
            key={action.id}
            className="flex min-h-12 items-center gap-1 px-1"
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-2 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={() => onEdit(action.id)}
              aria-label={t('settings.pageInteraction.actions.edit', [action.label])}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{action.label}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {action.kind === 'builtin'
                    ? t('settings.pageInteraction.actions.builtin')
                    : t('settings.pageInteraction.actions.custom')}
                  {!isUnrestrictedPageScope(action.pages) && (
                    <> · {t('settings.pageInteraction.actions.pageScoped')}</>
                  )}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </button>

            <Switch
              checked={action.enabled}
              onCheckedChange={(v) => onToggle(action.id, v)}
              className="shrink-0"
              aria-label={action.label}
            />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground"
                  aria-label={t('settings.pageInteraction.actions.more', [action.label])}
                >
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 max-w-[calc(100vw-1rem)]">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => onEdit(action.id)}>
                    <Pencil />
                    <span className="min-w-0 break-words">
                      {t('settings.pageInteraction.actions.edit', [action.label])}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={index === 0}
                    onSelect={() => onMove(action.id, -1)}
                  >
                    <ChevronUp />
                    <span className="min-w-0 break-words">
                      {t('settings.pageInteraction.actions.moveUp', [action.label])}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={index === actions.length - 1}
                    onSelect={() => onMove(action.id, 1)}
                  >
                    <ChevronDown />
                    <span className="min-w-0 break-words">
                      {t('settings.pageInteraction.actions.moveDown', [action.label])}
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                {action.kind === 'custom' && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setPendingDelete(action)}
                      >
                        <Trash2 />
                        <span className="min-w-0 break-words">
                          {t('settings.pageInteraction.actions.delete', [action.label])}
                        </span>
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>

      <Button type="button" variant="outline" size="sm" className="w-full" onClick={onCreate}>
        <Plus className="size-3.5" />
        {t('settings.pageInteraction.actions.create')}
      </Button>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('settings.pageInteraction.actions.deleteConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? t('settings.pageInteraction.actions.deleteConfirmDescription', [
                    pendingDelete.label,
                  ])
                : ''}
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

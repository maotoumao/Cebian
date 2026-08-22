import { ChevronRight, ChevronUp, ChevronDown, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
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
 * 工具条动作列表：内置与自定义混排一列，行上直接启停 / 调序 / 进编辑，自定义可删。
 * 顺序即工具条上的显示顺序，所以这里不做分组——用户看到的就是实际排布。
 *
 * 行内的 ChevronRight 放在「进编辑」那个按钮**内部**并靠右（而不是整行最右）：它标示的
 * 是「点这块进编辑」，摆在按钮外面就成了看着能点、点了没反应；而 Switch 与删除是另外两个
 * 独立控件，本不该被它涵盖。同时它保持 aria-hidden，无障碍名字由行按钮的 aria-label 给。
 */
export function ToolbarActionList({
  actions,
  onToggle,
  onMove,
  onDelete,
  onEdit,
  onCreate,
}: ToolbarActionListProps) {
  return (
    <div className="space-y-1">
      <ul className="space-y-1">
        {actions.map((action, index) => (
          <li
            key={action.id}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1.5"
          >
            <div className="flex flex-col">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-4 text-muted-foreground"
                disabled={index === 0}
                onClick={() => onMove(action.id, -1)}
                aria-label={t('settings.pageInteraction.actions.moveUp', [action.label])}
              >
                <ChevronUp className="size-3" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-4 text-muted-foreground"
                disabled={index === actions.length - 1}
                onClick={() => onMove(action.id, 1)}
                aria-label={t('settings.pageInteraction.actions.moveDown', [action.label])}
              >
                <ChevronDown className="size-3" />
              </Button>
            </div>

            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => onEdit(action.id)}
              aria-label={t('settings.pageInteraction.actions.edit', [action.label])}
            >
              <span className="truncate text-sm">{action.label}</span>
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                {action.kind === 'builtin'
                  ? t('settings.pageInteraction.actions.builtin')
                  : t('settings.pageInteraction.actions.custom')}
              </Badge>
              {!isUnrestrictedPageScope(action.pages) && (
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {t('settings.pageInteraction.actions.pageScoped')}
                </Badge>
              )}
              <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden />
            </button>

            <Switch
              checked={action.enabled}
              onCheckedChange={(v) => onToggle(action.id, v)}
              className="shrink-0"
              aria-label={action.label}
            />

            {action.kind === 'custom' && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={t('settings.pageInteraction.actions.delete', [action.label])}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t('settings.pageInteraction.actions.deleteConfirmTitle')}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t('settings.pageInteraction.actions.deleteConfirmDescription', [
                        action.label,
                      ])}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => onDelete(action.id)}
                    >
                      {t('common.delete')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </li>
        ))}
      </ul>

      <Button type="button" variant="outline" size="sm" className="w-full" onClick={onCreate}>
        <Plus className="size-3.5" />
        {t('settings.pageInteraction.actions.create')}
      </Button>
    </div>
  );
}

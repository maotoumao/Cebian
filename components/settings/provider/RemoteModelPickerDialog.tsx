import { useMemo, useState, type RefObject } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { t } from '@/lib/i18n';

interface RemoteModelPickerDialogProps {
  /** 服务商 `/models` 返回的模型 id（已去重，按远端顺序）。 */
  remoteIds: string[];
  /** 模型列表里现有的 id。已在列表里的远端模型初始勾选，其余不勾——首次获取即全部不勾。 */
  existingIds: ReadonlySet<string>;
  /** 关闭后接回焦点的元素（通常是「自动获取」按钮）。 */
  returnFocusRef?: RefObject<HTMLElement | null>;
  onConfirm: (selected: ReadonlySet<string>) => void;
  onCancel: () => void;
}

/**
 * 「自动获取」之后的模型勾选弹窗（issue #86）：服务商动辄返回上百个模型，让用户挑要的，
 * 而不是整批灌进列表。挂载即打开、关闭即由父组件卸载，勾选状态随之复位。
 *
 * 「全选」只作用于当前搜索结果，方便「搜 qwen → 全选」这类操作。
 */
function RemoteModelPickerDialog({ remoteIds, existingIds, returnFocusRef, onConfirm, onCancel }: RemoteModelPickerDialogProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(remoteIds.filter(id => existingIds.has(id))));

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? remoteIds.filter(id => id.toLowerCase().includes(q)) : remoteIds;
  }, [remoteIds, query]);

  const visibleSelected = visible.filter(id => selected.has(id)).length;
  const allState: boolean | 'indeterminate' =
    visibleSelected === 0 ? false : visibleSelected === visible.length ? true : 'indeterminate';

  const toggleAll = () => {
    setSelected(prev => {
      const next = new Set(prev);
      // 全选态再点 = 取消这批；未选 / 部分选中再点 = 补齐这批
      if (allState === true) visible.forEach(id => next.delete(id));
      else visible.forEach(id => next.add(id));
      return next;
    });
  };

  const toggle = (id: string, checked: boolean) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onCancel(); }}>
      <DialogContent
        className="max-w-lg"
        onCloseAutoFocus={e => {
          if (!returnFocusRef?.current) return;
          e.preventDefault();
          returnFocusRef.current.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('provider.form.pickModels.title')}</DialogTitle>
          <DialogDescription>{t('provider.form.pickModels.description')}</DialogDescription>
        </DialogHeader>

        {remoteIds.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('provider.form.pickModels.empty')}</p>
        ) : (
          <div className="min-w-0 space-y-2">
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('provider.form.pickModels.search')}
              aria-label={t('provider.form.pickModels.search')}
              className="h-8 text-sm"
            />
            <div className="flex items-center justify-between gap-2 text-xs">
              <label className="flex items-center gap-2">
                <Checkbox checked={allState} onCheckedChange={toggleAll} disabled={visible.length === 0} />
                <span>{t('provider.form.pickModels.selectAll')}</span>
              </label>
              <span className="tabular-nums text-muted-foreground">
                {t('provider.form.pickModels.count', [String(selected.size), String(remoteIds.length)])}
              </span>
            </div>
            <div className="max-h-[50vh] divide-y divide-border/50 overflow-y-auto rounded-md border border-border">
              {visible.map(id => (
                <label key={id} className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs hover:bg-muted/50">
                  <Checkbox checked={selected.has(id)} onCheckedChange={v => toggle(id, v === true)} />
                  <span className="min-w-0 truncate font-mono" title={id}>{id}</span>
                </label>
              ))}
              {visible.length === 0 && (
                <p className="px-2 py-3 text-xs text-muted-foreground">{t('provider.form.pickModels.noMatch')}</p>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
          {remoteIds.length > 0 && <Button onClick={() => onConfirm(selected)}>{t('common.confirm')}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { RemoteModelPickerDialog };

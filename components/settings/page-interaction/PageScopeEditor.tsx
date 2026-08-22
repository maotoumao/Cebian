import { useId, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { PagePatternsEditor } from './PagePatternsEditor';
import type { PageScope } from '@/lib/page-actions/match';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

interface PageScopeEditorProps {
  scope: PageScope;
  onChange: (next: PageScope) => void;
  /** 上级开关关闭时置灰（规则仍保留，只是当下不起作用）。 */
  disabled?: boolean;
}

/**
 * 页面生效范围编辑器：悬浮球、划词工具条、每个划词动作共用同一份 UI 与同一套语义
 * （include 空 = 所有页面，exclude 优先扣除）。
 *
 * 「排除」列表默认收起：绝大多数场景只用其中一个方向，两个列表全摊开会把设置页撑满。
 * 展开与否是**推导**出来的而不是挂载时算一次的状态——主面板首帧拿到的是 storage 的
 * fallback（空范围），真值稍后才到，若用初值锁死就会把已有的排除规则藏起来。
 * 用户一旦碰过这块（展开或改动）就固定展开，免得删掉最后一条规则时整段突然消失。
 */
export function PageScopeEditor({ scope, onChange, disabled }: PageScopeEditorProps) {
  const [pinned, setPinned] = useState(false);
  const showExclude = pinned || scope.exclude.length > 0;
  const includeLabelId = useId();
  const excludeLabelId = useId();

  return (
    <div className={cn('space-y-2', disabled && 'pointer-events-none opacity-50')}>
      <div className="space-y-1.5">
        <Label id={includeLabelId} className="text-xs font-normal text-muted-foreground">
          {t('settings.pageInteraction.pageScope.include')}
        </Label>
        <PagePatternsEditor
          patterns={scope.include}
          onChange={(include) => onChange({ ...scope, include })}
          disabled={disabled}
          labelledBy={includeLabelId}
        />
        <p className="text-xs text-muted-foreground">
          {t('settings.pageInteraction.pageScope.includeHint')}
        </p>
      </div>

      {showExclude ? (
        <div className="space-y-1.5">
          <Label id={excludeLabelId} className="text-xs font-normal text-muted-foreground">
            {t('settings.pageInteraction.pageScope.exclude')}
          </Label>
          <PagePatternsEditor
            patterns={scope.exclude}
            onChange={(exclude) => {
              setPinned(true);
              onChange({ ...scope, exclude });
            }}
            disabled={disabled}
            labelledBy={excludeLabelId}
          />
          <p className="text-xs text-muted-foreground">
            {t('settings.pageInteraction.pageScope.excludeHint')}
          </p>
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          disabled={disabled}
          onClick={() => setPinned(true)}
        >
          <Plus className="size-3" />
          {t('settings.pageInteraction.pageScope.addExclude')}
        </Button>
      )}

      <p className="text-xs text-muted-foreground">
        {t('settings.pageInteraction.pageScope.syntax')}
      </p>
    </div>
  );
}

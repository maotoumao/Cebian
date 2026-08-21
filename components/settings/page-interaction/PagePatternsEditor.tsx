import { useId, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { validatePagePattern } from '@/lib/page-actions/match';
import { t } from '@/lib/i18n';

interface PagePatternsEditorProps {
  patterns: string[];
  onChange: (next: string[]) => void;
  /** 上级开关关闭时置灰（规则仍保留，只是当下不起作用）。 */
  disabled?: boolean;
  /** 调用方可见标签的 id：让输入框的无障碍名字就是那句标签，而不是示例 pattern。 */
  labelledBy?: string;
}

/**
 * 页面匹配规则列表编辑器（match pattern）。悬浮球 / 工具条的「隐藏页面」与单个划词
 * 动作的「仅在这些页面显示」共用。
 *
 * 只在「添加」时落库，已添加的规则是只读条目 + 移除按钮——不做行内实时编辑，因为
 * 调用方每次 onChange 都直接写 storage，逐字符写入既嘈杂又会把半截非法规则存进去。
 * 校验不通过的规则进不了列表，运行时那份容错（见 matchesAnyPagePattern）只兜历史脏数据。
 */
export function PagePatternsEditor({
  patterns,
  onChange,
  disabled,
  labelledBy,
}: PagePatternsEditorProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  // 校验失败是用户刚按下「添加」的直接反馈：错误段落挂 role="alert" 让读屏也能拿到，
  // 并用 errorId 经 aria-describedby 关联回输入框。
  const errorId = useId();

  const add = () => {
    const next = draft.trim();
    if (!next) return;
    if (validatePagePattern(next) !== null) {
      setError(t('errors.pagePattern.invalid'));
      return;
    }
    if (patterns.includes(next)) {
      setError(t('errors.pagePattern.duplicate'));
      return;
    }
    onChange([...patterns, next]);
    setDraft('');
    setError(null);
  };

  return (
    <div className="space-y-1">
      {patterns.length > 0 && (
        <ul className="space-y-1">
          {patterns.map((pattern) => (
            <li key={pattern} className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate rounded-md border border-input px-2 py-1 font-mono text-xs">
                {pattern}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => onChange(patterns.filter((p) => p !== pattern))}
                disabled={disabled}
                aria-label={t('settings.pageInteraction.pagePattern.remove', [pattern])}
              >
                <X className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1">
        <Input
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={t('settings.pageInteraction.pagePattern.placeholder')}
          aria-labelledby={labelledBy}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error !== null}
          disabled={disabled}
          className="h-8 flex-1 font-mono text-sm"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0"
          onClick={add}
          disabled={disabled || draft.trim().length === 0}
        >
          <Plus className="size-3.5" />
          {t('common.add')}
        </Button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

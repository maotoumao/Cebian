import { useId, useState } from 'react';
import { Check, Pencil, Plus, X } from 'lucide-react';
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
 * 页面匹配规则列表编辑器（match pattern）：一个 `PageScope` 里 include / exclude 各挂
 * 一份，由 PageScopeEditor 组装；悬浮球、工具条与每个划词动作三层都用同一份。
 *
 * 新增或编辑规则都先在本地缓冲，只在用户确认且校验通过后调用一次 onChange，避免把
 * 半截非法规则写进 storage。运行时那份容错（见 matchesAnyPagePattern）只兜历史脏数据
 */
export function PagePatternsEditor({
  patterns,
  onChange,
  disabled,
  labelledBy,
}: PagePatternsEditorProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    index: number;
    draft: string;
    error: string | null;
  } | null>(null);
  // 校验失败是用户刚按下「添加」的直接反馈：错误段落挂 role="alert" 让读屏也能拿到，
  // 并用 errorId 经 aria-describedby 关联回输入框。
  const errorId = useId();
  const editErrorId = useId();

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

  const saveEdit = () => {
    if (!editing) return;
    const next = editing.draft.trim();
    if (validatePagePattern(next) !== null) {
      setEditing({ ...editing, error: t('errors.pagePattern.invalid') });
      return;
    }
    if (patterns.some((pattern, index) => index !== editing.index && pattern === next)) {
      setEditing({ ...editing, error: t('errors.pagePattern.duplicate') });
      return;
    }
    onChange(patterns.map((pattern, index) => index === editing.index ? next : pattern));
    setEditing(null);
  };

  return (
    <div className="space-y-1">
      {patterns.length > 0 && (
        <ul className="flex flex-col gap-1">
          {patterns.map((pattern, index) => {
            const isEditing = editing?.index === index;
            return (
              <li key={`${pattern}-${index}`} className="flex flex-col gap-1">
                <div className="flex min-w-0 items-center gap-1">
                  {isEditing ? (
                    <Input
                      autoFocus
                      value={editing.draft}
                      onChange={(e) => setEditing({ ...editing, draft: e.target.value, error: null })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          saveEdit();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setEditing(null);
                        }
                      }}
                      aria-labelledby={labelledBy}
                      aria-describedby={editing.error ? editErrorId : undefined}
                      aria-invalid={editing.error !== null}
                      disabled={disabled}
                      className="h-8 flex-1 font-mono text-sm"
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate px-2 py-1 font-mono text-xs" title={pattern}>
                      {pattern}
                    </span>
                  )}
                  {isEditing ? (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={saveEdit}
                        disabled={disabled || editing.draft.trim().length === 0}
                        aria-label={t('common.save')}
                      >
                        <Check />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() => setEditing(null)}
                        disabled={disabled}
                        aria-label={t('common.cancel')}
                      >
                        <X />
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() => setEditing({ index, draft: pattern, error: null })}
                        disabled={disabled || editing !== null}
                        aria-label={t('settings.pageInteraction.pagePattern.edit', [pattern])}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => onChange(patterns.filter((_, candidateIndex) => candidateIndex !== index))}
                        disabled={disabled || editing !== null}
                        aria-label={t('settings.pageInteraction.pagePattern.remove', [pattern])}
                      >
                        <X />
                      </Button>
                    </>
                  )}
                </div>
                {isEditing && editing.error && (
                  <p id={editErrorId} role="alert" className="text-xs text-destructive">
                    {editing.error}
                  </p>
                )}
              </li>
            );
          })}
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
          disabled={disabled || editing !== null}
          className="h-8 flex-1 font-mono text-sm"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0"
          onClick={add}
          disabled={disabled || editing !== null || draft.trim().length === 0}
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

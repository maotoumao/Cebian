import { useId, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CodeMirrorEditor } from '@/components/editor/CodeMirrorEditor';
import { PageScopeEditor } from './PageScopeEditor';
import { TranslateTargetSelector } from './TranslateTargetSelector';
import { useIsDark } from '@/hooks/useIsDark';
import type { PageActionDraft } from '@/lib/page-actions/types';
import { t } from '@/lib/i18n';

interface ToolbarActionEditorProps {
  /** 初始草稿（新建 = 空白草稿，编辑 = 由现有动作转来）。 */
  initial: PageActionDraft;
  onSave: (draft: PageActionDraft) => void;
  /** 正在写入 storage：按钮禁用并显示为进行中，避免重复提交。 */
  saving?: boolean;
  onBack: () => void;
}

/**
 * 单个划词动作的编辑页（页面交互设置下的子路由，不用 Dialog——侧边栏太窄，
 * CodeMirror 与规则列表在弹窗里铺不开）。
 *
 * 表单在本地缓冲、点保存才写库：提示词是 CodeMirror 文档，逐字符写 storage 既嘈杂
 * 又会把半成品配置推给正在浏览的页面。
 *
 * 后处理脚本写的是完整的 `transform(text, vars)` 函数（宿主按名字查到并调用），不是函数体。
 *
 * 内置动作只暴露外观 / 生效范围（名称、页面规则、后处理脚本），**不展示提示词**
 * ——它定义在代码里且不可改，展示出来只会让人以为能改。个别内置动作有自己的专属参数
 * （目前只有「翻译」的目标语言），按 `draft` 上有没有对应字段决定是否渲染——为一个字段
 * 建通用的参数描述符体系是过度设计。
 */
export function ToolbarActionEditor({ initial, onSave, saving, onBack }: ToolbarActionEditorProps) {
  const [draft, setDraft] = useState<PageActionDraft>(initial);
  const isDark = useIsDark();
  const promptLabelId = useId();
  const transformLabelId = useId();

  const isBuiltin = draft.kind === 'builtin';
  // 自定义动作至少要有名字和提示词才存得住；内置动作随时可存（全空即回到默认）。
  const canSave = isBuiltin || (draft.label.trim().length > 0 && draft.systemPrompt.trim().length > 0);

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-6 space-y-5">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onBack}
        >
          <ArrowLeft className="size-4" />
          <span className="sr-only">{t('common.back')}</span>
        </Button>
        <h2 className="text-base font-semibold">
          {isBuiltin
            ? t('settings.pageInteraction.actions.editBuiltin')
            : t('settings.pageInteraction.actions.editCustom')}
        </h2>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="action-label" className="text-sm">
          {t('settings.pageInteraction.actions.label')}
        </Label>
        <Input
          id="action-label"
          value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          placeholder={
            isBuiltin
              ? t('settings.pageInteraction.actions.labelFollowLocale')
              : t('settings.pageInteraction.actions.labelPlaceholder')
          }
        />
        {isBuiltin && (
          <p className="text-xs text-muted-foreground">
            {t('settings.pageInteraction.actions.labelBuiltinHint')}
          </p>
        )}
      </div>

      {!isBuiltin && (
        <div className="space-y-1.5">
          <Label id={promptLabelId} className="text-sm">
            {t('settings.pageInteraction.actions.prompt')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('settings.pageInteraction.actions.promptHint', ['{{'])}
          </p>
          <div className="h-56 overflow-hidden rounded-md border border-border">
            <CodeMirrorEditor
              value={draft.systemPrompt}
              onChange={(value) => setDraft({ ...draft, systemPrompt: value })}
              language="markdown"
              isDark={isDark}
              templateVarScene="pageAction"
              labelledBy={promptLabelId}
              placeholder={t('settings.pageInteraction.actions.promptPlaceholder', [
                '{{selected_text}}',
                '{{ui_language}}',
              ])}
            />
          </div>
        </div>
      )}

      {draft.translateTarget !== undefined && (
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <Label className="text-sm">{t('settings.pageInteraction.translate.label')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('settings.pageInteraction.translate.hint')}
            </p>
          </div>
          <div className="shrink-0">
            <TranslateTargetSelector
              value={draft.translateTarget}
              onSelect={(target) => setDraft({ ...draft, translateTarget: target })}
            />
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <Label className="text-sm">{t('settings.pageInteraction.actions.pages')}</Label>
        <PageScopeEditor
          scope={draft.pages}
          onChange={(pages) => setDraft({ ...draft, pages })}
        />
      </div>

      <div className="space-y-1.5">
        <Label id={transformLabelId} className="text-sm">
          {t('settings.pageInteraction.actions.transform')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {t('settings.pageInteraction.actions.transformHint')}
        </p>
        <div className="h-40 overflow-hidden rounded-md border border-border">
          <CodeMirrorEditor
            value={draft.transform}
            onChange={(value) => setDraft({ ...draft, transform: value })}
            language="javascript"
            isDark={isDark}
            labelledBy={transformLabelId}
            placeholder={t('settings.pageInteraction.actions.transformPlaceholder')}
          />
        </div>
      </div>

      <div className="flex justify-end gap-2 pb-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          {t('common.cancel')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canSave || saving}
          onClick={() => onSave(draft)}
        >
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}

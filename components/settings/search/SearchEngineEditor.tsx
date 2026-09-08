import { useId, useState } from 'react';
import { ArrowLeft, RotateCcw, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CodeMirrorEditor } from '@/components/editor/CodeMirrorEditor';
import { useIsDark } from '@/hooks/useIsDark';
import { resetBuiltinSearchEngineDraft } from '@/lib/search/edit-config';
import { buildSearchUrl, validateUrlTemplate } from '@/lib/search/engines';
import { extractScriptFromSelector, validateExtractScript } from '@/lib/search/extract';
import { QUERY_PLACEHOLDER, type SearchEngineDraft } from '@/lib/search/types';
import { t } from '@/lib/i18n';

interface SearchEngineEditorProps {
  /** 初始草稿（新建 = 预填模板脚本的空白草稿，编辑 = 由现有引擎转来）。 */
  initial: SearchEngineDraft;
  onSave: (draft: SearchEngineDraft) => void;
  /** 正在写入 storage：按钮禁用，避免重复提交。 */
  saving?: boolean;
  onBack: () => void;
}

/** 示例搜索词，用来在地址栏下方展示模板填好后的样子。 */
const SAMPLE_QUERY = 'cebian';

/** 脚本契约签名，随代码块原样展示，不翻译。 */
const CONTRACT = `function extract({ document, query }) {
  return { status: 'ok' | 'empty' | 'blocked', results: [{ title, url, snippet }] };
}`;

/**
 * 单个搜索引擎的编辑页（「对话」设置下的子路由，不用 Dialog——侧边栏太窄，脚本编辑器
 * 在弹窗里铺不开）。表单在本地缓冲、点保存才写库。
 *
 * 内置与自定义引擎共用同一组字段：内置引擎的名称锁死（随界面语言），地址 / 脚本 / 适用
 * 场景可改，与默认相同的字段保存时会被省略；「恢复默认值」把三个字段一起还原。
 * 自定义引擎多一行「从选择器生成模板」：填结果容器的选择器，生成一份能跑的起手脚本。
 */
export function SearchEngineEditor({ initial, onSave, saving, onBack }: SearchEngineEditorProps) {
  const [draft, setDraft] = useState<SearchEngineDraft>(initial);
  const [selector, setSelector] = useState('#results');
  const [urlTouched, setUrlTouched] = useState(false);
  // 程序化替换脚本（恢复默认 / 生成模板）时重建 CodeMirror 实例，避免与用户输入的同步打架。
  const [scriptEditorKey, setScriptEditorKey] = useState(0);
  const isDark = useIsDark();
  const scriptLabelId = useId();

  const isBuiltin = draft.kind === 'builtin';
  const urlProblem = validateUrlTemplate(draft.urlTemplate.trim());
  const scriptValid = validateExtractScript(draft.extract);
  const canSave = (isBuiltin || draft.name.trim().length > 0) && urlProblem === null && scriptValid;
  const showUrlProblem = urlTouched && urlProblem !== null;

  const replaceScript = (next: SearchEngineDraft) => {
    setDraft(next);
    setScriptEditorKey((k) => k + 1);
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-6 space-y-5">
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="icon" className="size-7" onClick={onBack}>
          <ArrowLeft className="size-4" />
          <span className="sr-only">{t('common.back')}</span>
        </Button>
        <h2 className="text-base font-semibold">
          {isBuiltin ? t('settings.chat.search.editBuiltin') : t('settings.chat.search.editCustom')}
        </h2>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="engine-name" className="text-sm">{t('settings.chat.search.name')}</Label>
        <Input
          id="engine-name"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder={t('settings.chat.search.namePlaceholder')}
          disabled={isBuiltin}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="engine-url" className="text-sm">{t('settings.chat.search.url')}</Label>
        <p className="text-xs text-muted-foreground">{t('settings.chat.search.urlHint', [QUERY_PLACEHOLDER])}</p>
        <Input
          id="engine-url"
          className="font-mono text-xs"
          value={draft.urlTemplate}
          onChange={(e) => setDraft({ ...draft, urlTemplate: e.target.value })}
          onBlur={() => setUrlTouched(true)}
          placeholder={`https://example.com/search?q=${QUERY_PLACEHOLDER}`}
          aria-invalid={showUrlProblem}
        />
        {showUrlProblem ? (
          <p className="text-xs text-destructive">
            {urlProblem === 'missingPlaceholder'
              ? t('errors.searchEngineUrlMissingPlaceholder', [QUERY_PLACEHOLDER])
              : t('errors.searchEngineUrlInvalid')}
          </p>
        ) : urlProblem === null ? (
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            {t('settings.chat.search.urlPreview', [SAMPLE_QUERY, buildSearchUrl(draft.urlTemplate.trim(), SAMPLE_QUERY)])}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label id={scriptLabelId} className="text-sm">{t('settings.chat.search.script')}</Label>
        <p className="text-xs text-muted-foreground">{t('settings.chat.search.scriptHint')}</p>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {CONTRACT}
        </pre>
        {!isBuiltin && (
          <div className="flex items-center gap-2">
            <Input
              className="h-8 font-mono text-xs"
              value={selector}
              onChange={(e) => setSelector(e.target.value)}
              placeholder={t('settings.chat.search.generateSelectorPlaceholder')}
              aria-label={t('settings.chat.search.generateSelectorPlaceholder')}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={selector.trim().length === 0}
              onClick={() => replaceScript({ ...draft, extract: extractScriptFromSelector(selector.trim()) })}
            >
              <Wand2 className="size-3.5" />
              {t('settings.chat.search.generate')}
            </Button>
          </div>
        )}
        <div className="h-72 overflow-hidden rounded-md border border-border">
          <CodeMirrorEditor
            key={scriptEditorKey}
            value={draft.extract}
            onChange={(value) => setDraft({ ...draft, extract: value })}
            language="javascript"
            isDark={isDark}
            labelledBy={scriptLabelId}
          />
        </div>
        {!scriptValid && <p className="text-xs text-destructive">{t('errors.searchEngineScriptInvalid')}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="engine-when" className="text-sm">{t('settings.chat.search.when')}</Label>
        <p className="text-xs text-muted-foreground">{t('settings.chat.search.whenHint')}</p>
        <Input
          id="engine-when"
          value={draft.when}
          onChange={(e) => setDraft({ ...draft, when: e.target.value })}
          placeholder={t('settings.chat.search.whenPlaceholder')}
        />
      </div>

      <div className="flex items-center justify-between gap-2 pb-2">
        {isBuiltin ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => replaceScript(resetBuiltinSearchEngineDraft(draft))}
          >
            <RotateCcw className="size-4" />
            {t('common.reset')}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onBack}>
            {t('common.cancel')}
          </Button>
          <Button type="button" size="sm" disabled={!canSave || saving} onClick={() => onSave(draft)}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}

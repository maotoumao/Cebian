/**
 * CodeMirror 6 扩展：`{{变量}}` 的自动完成。
 *
 * 用户敲 `{{` 时触发，只列出该场景真能取到值的内置变量（如剪贴板变量不出现在划词
 * 动作里，因为内容脚本读剪贴板取不稳）。
 */
import { type CompletionContext, type CompletionResult, autocompletion } from '@codemirror/autocomplete';
import { templateVariablesFor, type TemplateScene } from '@/lib/ai-config/template';

function templateCompletionSource(
  context: CompletionContext,
  scene: TemplateScene,
): CompletionResult | null {
  // 匹配 `{{` 以及其后可能已敲了一半的变量名
  const match = context.matchBefore(/\{\{(\w*)$/);
  if (!match) return null;

  return {
    from: match.from + 2,
    options: templateVariablesFor(scene).map((v) => ({
      label: v.name,
      detail: v.getLabel(),
      apply: `${v.name}}}`,
      type: 'variable' as const,
    })),
    filter: true,
  };
}

/** 扩展包：某个场景下的模板变量自动完成。 */
export function templateCompletion(scene: TemplateScene) {
  return autocompletion({
    override: [(context) => templateCompletionSource(context, scene)],
    activateOnTyping: true,
  });
}

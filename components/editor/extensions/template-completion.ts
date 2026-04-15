/**
 * CodeMirror 6 extension: autocomplete for {{variable}} template placeholders.
 *
 * Triggers when the user types `{{` and shows a list of built-in template variables.
 */
import { type CompletionContext, type CompletionResult, autocompletion } from '@codemirror/autocomplete';
import { TEMPLATE_VARIABLES } from '@/lib/ai-config/template';

function templateCompletionSource(context: CompletionContext): CompletionResult | null {
  // Match `{{` optionally followed by partial word
  const match = context.matchBefore(/\{\{(\w*)$/);
  if (!match) return null;

  return {
    from: match.from + 2,
    options: TEMPLATE_VARIABLES.map((v) => ({
      label: v.name,
      detail: v.label,
      apply: `${v.name}}}`,
      type: 'variable' as const,
    })),
    filter: true,
  };
}

/** Extension bundle: template variable autocomplete. */
export function templateCompletion() {
  return autocompletion({
    override: [templateCompletionSource],
    activateOnTyping: true,
  });
}

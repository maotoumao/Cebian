/**
 * CodeMirror 6 extension: highlight {{variable}} template placeholders.
 *
 * Uses MatchDecorator to find all occurrences of {{word}} and render them
 * as Mark Decorations with a distinct visual style.
 */
import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';

const templateMark = Decoration.mark({ class: 'cm-template-var' });

const matcher = new MatchDecorator({
  regexp: /\{\{\w+\}\}/g,
  decoration: () => templateMark,
});

const templateHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = matcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = matcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Theme-aware styles for template variable highlights. */
const templateHighlightTheme = EditorView.baseTheme({
  '.cm-template-var': {
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    color: '#60a5fa',
    borderRadius: '3px',
    padding: '0 2px',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.9em',
  },
});

/** Extension bundle: template variable highlighting. */
export function templateHighlight() {
  return [templateHighlightPlugin, templateHighlightTheme];
}

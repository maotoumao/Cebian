/**
 * CodeMirror 6 React wrapper component.
 *
 * Provides a ready-to-use editor with theme sync, language support,
 * and optional {{variable}} template highlighting/completion.
 */
import { useRef, useEffect, useState, useMemo } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  keymap,
  placeholder as cmPlaceholder,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { javascript } from '@codemirror/lang-javascript';
import { syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { oneDark } from '@codemirror/theme-one-dark';
import { Spinner } from '@/components/ui/spinner';
import { templateHighlight } from './extensions/template-highlight';
import { templateCompletion } from './extensions/template-completion';
import type { TemplateScene } from '@/lib/ai-config/template';

// ─── Language resolver ───

function getLanguageExtension(lang?: string) {
  switch (lang) {
    case 'markdown': return markdown();
    case 'yaml': return yaml();
    case 'javascript': return javascript();
    default: return markdown();
  }
}

// Custom highlight: remove heading underlines, YAML light-mode contrast
const customHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, textDecoration: 'none', fontWeight: 'bold' },
  { tag: tags.heading1, textDecoration: 'none', fontWeight: 'bold' },
  { tag: tags.heading2, textDecoration: 'none', fontWeight: 'bold' },
  { tag: tags.heading3, textDecoration: 'none', fontWeight: 'bold' },
  { tag: tags.emphasis, textDecoration: 'none', fontStyle: 'italic' },
  { tag: tags.strong, textDecoration: 'none', fontWeight: 'bold' },
]);

// ─── Props ───

interface CodeMirrorEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: 'markdown' | 'yaml' | 'javascript';
  isDark?: boolean;
  placeholder?: string;
  readOnly?: boolean;
  /** 传入场景即开启 {{变量}} 高亮 + 自动完成，并按场景过滤可用变量；不传则不开。 */
  templateVarScene?: TemplateScene;
  /** 可见标签的 id：挂到真正带 role="textbox" 的 content DOM 上，读屏才念得出这是什么框。 */
  labelledBy?: string;
  className?: string;
}

// ─── Component ───

export function CodeMirrorEditor({
  value,
  onChange,
  language = 'markdown',
  isDark = true,
  placeholder = '',
  readOnly = false,
  templateVarScene,
  labelledBy,
  className = '',
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const [ready, setReady] = useState(false);

  // Compartments for dynamic reconfiguration (no editor recreation needed)
  const themeComp = useMemo(() => new Compartment(), []);
  const readOnlyComp = useMemo(() => new Compartment(), []);

  // Keep onChange ref current without recreating editor
  onChangeRef.current = onChange;

  // Create editor on mount
  useEffect(() => {
    if (!containerRef.current) return;

    const extensions = [
      lineNumbers(),
      drawSelection(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      syntaxHighlighting(customHighlightStyle),
      getLanguageExtension(language),
      EditorView.lineWrapping,
      EditorView.theme({
        '&.cm-focused': { outline: 'none' },
        '.cm-content': { fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace' },
        '.cm-gutters': { fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace' },
      }),
      themeComp.of(isDark ? oneDark : []),
      readOnlyComp.of(EditorState.readOnly.of(readOnly)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
    ];

    if (labelledBy) {
      extensions.push(EditorView.contentAttributes.of({ 'aria-labelledby': labelledBy }));
    }
    if (placeholder) extensions.push(cmPlaceholder(placeholder));
    if (templateVarScene) {
      extensions.push(templateHighlight());
      extensions.push(templateCompletion(templateVarScene));
    }

    const state = EditorState.create({ doc: value, extensions });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    setReady(true);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, templateVarScene, placeholder, labelledBy]);

  // Reconfigure theme without destroying editor
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeComp.reconfigure(isDark ? oneDark : []),
    });
  }, [isDark, themeComp]);

  // Reconfigure readOnly without destroying editor
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyComp.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly, readOnlyComp]);

  // Sync external value changes (e.g. switching files) without recreating editor
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc !== value) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className={`relative ${className}`}>
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/50 z-10">
          <Spinner className="size-5" />
        </div>
      )}
      <div
        ref={containerRef}
        className="min-h-[200px] h-full [&_.cm-editor]:h-full [&_.cm-scroller]:overflow-auto text-[13px]"
      />
    </div>
  );
}

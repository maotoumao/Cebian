/**
 * CodeMirror 6 React wrapper component.
 *
 * Provides a ready-to-use editor with theme sync, language support,
 * and optional {{variable}} template highlighting/completion.
 */
import { useRef, useEffect, useState, useMemo } from 'react';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, placeholder as cmPlaceholder, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { javascript } from '@codemirror/lang-javascript';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { Spinner } from '@/components/ui/spinner';
import { templateHighlight } from './extensions/template-highlight';
import { templateCompletion } from './extensions/template-completion';

// ─── Language resolver ───

function getLanguageExtension(lang?: string) {
  switch (lang) {
    case 'markdown': return markdown();
    case 'yaml': return yaml();
    case 'javascript': return javascript();
    default: return markdown();
  }
}

// ─── Props ───

interface CodeMirrorEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: 'markdown' | 'yaml' | 'javascript';
  isDark?: boolean;
  placeholder?: string;
  readOnly?: boolean;
  /** Enable {{variable}} highlighting + autocomplete (Prompts only). */
  enableTemplateVars?: boolean;
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
  enableTemplateVars = false,
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
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      getLanguageExtension(language),
      EditorView.lineWrapping,
      themeComp.of(isDark ? oneDark : []),
      readOnlyComp.of(EditorState.readOnly.of(readOnly)),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
    ];

    if (placeholder) extensions.push(cmPlaceholder(placeholder));
    if (enableTemplateVars) {
      extensions.push(templateHighlight());
      extensions.push(templateCompletion());
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
  }, [language, enableTemplateVars, placeholder]);

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
        className="min-h-[200px] h-full [&_.cm-editor]:h-full [&_.cm-editor]:outline-none [&_.cm-editor.cm-focused]:outline-none [&_.cm-scroller]:overflow-auto text-[13px]"
      />
    </div>
  );
}

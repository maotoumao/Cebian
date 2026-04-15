/**
 * EditorPanel — pure VFS file editor.
 *
 * Displays a CodeMirror editor for the given filePath, with save/reset controls.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/editor/CodeMirrorEditor';
import { vfs } from '@/lib/vfs';

// ─── Types ───

interface EditorPanelProps {
  /** Full VFS path to edit. */
  filePath?: string;
  /** Theme for CodeMirror. */
  isDark: boolean;
  /** Enable {{variable}} template highlighting + autocomplete. */
  enableTemplateVars?: boolean;
  /** Called after save. */
  onSave?: () => void;
}

function detectLanguage(filePath: string): 'markdown' | 'yaml' | 'javascript' {
  if (filePath.endsWith('.js') || filePath.endsWith('.ts')) return 'javascript';
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) return 'yaml';
  return 'markdown';
}

// ─── Component ───

export function EditorPanel({ filePath, isDark, enableTemplateVars = false, onSave }: EditorPanelProps) {
  const [body, setBody] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(false);

  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;

  const language = filePath ? detectLanguage(filePath) : 'markdown';
  const dirty = !!filePath && body !== savedContent;

  // Load file content
  const loadFile = useCallback(async () => {
    if (!filePath) return;
    setLoading(true);
    try {
      const raw = await vfs.readFile(filePath, 'utf8');
      const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      if (filePath !== filePathRef.current) return;
      setSavedContent(content);
      setBody(content);
    } catch {
      setBody('');
      setSavedContent('');
    } finally {
      setLoading(false);
    }
  }, [filePath]);

  useEffect(() => { loadFile(); }, [loadFile]);

  const handleSave = async () => {
    if (!filePath) return;
    await vfs.writeFile(filePath, body);
    setSavedContent(body);
    onSave?.();
  };

  const handleReset = () => {
    setBody(savedContent);
  };

  if (!filePath) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        选择一个文件开始编辑
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        加载中...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0">
        <CodeMirrorEditor
          value={body}
          onChange={setBody}
          language={language}
          isDark={isDark}
          enableTemplateVars={enableTemplateVars}
          className="h-full"
        />
      </div>
      <div className="flex items-center justify-end gap-2 p-2 border-t border-border shrink-0">
        <Button variant="ghost" size="sm" onClick={handleReset} disabled={!dirty}>
          重置
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!dirty}>
          {dirty && <span className="mr-1">●</span>}
          保存
        </Button>
      </div>
    </div>
  );
}

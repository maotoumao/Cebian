/**
 * EditorPanel — generic VFS file editor with optional embedded file tree.
 *
 * When `workspace` is provided, shows a file tree on the left for that directory
 * and manages file selection internally. Otherwise, edits the given `filePath`.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/editor/CodeMirrorEditor';
import { FileTree } from '@/components/editor/FileTree';
import { vfs } from '@/lib/vfs';

// ─── Types ───

interface EditorPanelProps {
  /** Full VFS path to edit directly (used when workspace is not set). */
  filePath?: string;
  /** Root folder — when set, shows an embedded file tree and manages selection internally. */
  workspace?: string;
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

export function EditorPanel({ filePath: externalFilePath, workspace, isDark, enableTemplateVars = false, onSave }: EditorPanelProps) {
  // When workspace is set, file selection is managed internally
  const [internalFile, setInternalFile] = useState('');
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);

  const activeFile = workspace ? internalFile : (externalFilePath ?? '');

  const [body, setBody] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);

  const filePathRef = useRef(activeFile);
  filePathRef.current = activeFile;

  const language = activeFile ? detectLanguage(activeFile) : 'markdown';

  // Reset internal selection when workspace changes
  useEffect(() => {
    setInternalFile('');
  }, [workspace]);

  // Load file content
  const loadFile = useCallback(async () => {
    if (!activeFile) return;
    setLoading(true);
    try {
      const raw = await vfs.readFile(activeFile, 'utf8');
      const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      if (activeFile !== filePathRef.current) return;
      setSavedContent(content);
      setBody(content);
      setDirty(false);
    } catch {
      setBody('');
      setSavedContent('');
    } finally {
      setLoading(false);
    }
  }, [activeFile]);

  useEffect(() => { loadFile(); }, [loadFile]);

  // Dirty check
  useEffect(() => {
    if (!activeFile) { setDirty(false); return; }
    setDirty(body !== savedContent);
  }, [activeFile, body, savedContent]);

  const handleSave = async () => {
    if (!activeFile) return;
    await vfs.writeFile(activeFile, body);
    setSavedContent(body);
    setDirty(false);
    if (workspace) setTreeRefreshKey((k) => k + 1);
    onSave?.();
  };

  const handleReset = () => {
    setBody(savedContent);
    setDirty(false);
  };

  // ─── No selection state ───

  const emptyState = (
    <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
      选择一个文件开始编辑
    </div>
  );

  const loadingState = (
    <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
      加载中...
    </div>
  );

  // ─── Editor content ───

  const editorContent = !activeFile ? emptyState : loading ? loadingState : (
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

  // ─── With workspace: file tree + editor ───

  if (workspace) {
    return (
      <div className="flex h-full">
        <div className="w-44 shrink-0 border-r border-border overflow-hidden">
          <FileTree
            root={workspace}
            selectedFile={internalFile}
            onSelect={setInternalFile}
            refreshKey={treeRefreshKey}
          />
        </div>
        <div className="flex-1 min-w-0">
          {editorContent}
        </div>
      </div>
    );
  }

  // ─── Without workspace: just editor ───

  return editorContent;
}

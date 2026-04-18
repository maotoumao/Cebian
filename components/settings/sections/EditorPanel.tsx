/**
 * EditorPanel — VFS file editor with auto-save.
 *
 * Save strategy:
 * - Debounced write 500ms after content stops changing.
 * - Immediate flush on Ctrl/Cmd+S, file switch, unmount, or page unload.
 * - Subtle footer status (settings.editor.{saved,saving,unsaved}) — no buttons.
 * - Write errors surface via `sonner` toast but don't block further edits.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { CodeMirrorEditor } from '@/components/editor/CodeMirrorEditor';
import { vfs } from '@/lib/vfs';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

const AUTOSAVE_DEBOUNCE_MS = 500;

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface EditorPanelProps {
  /** Full VFS path to edit. */
  filePath?: string;
  /** Root path for computing relative breadcrumb. */
  rootPath?: string;
  /** Theme for CodeMirror. */
  isDark: boolean;
  /** Enable {{variable}} template highlighting + autocomplete. */
  enableTemplateVars?: boolean;
  /** Called after a successful save. */
  onSave?: () => void;
}

function detectLanguage(filePath: string): 'markdown' | 'yaml' | 'javascript' {
  if (filePath.endsWith('.js') || filePath.endsWith('.ts')) return 'javascript';
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) return 'yaml';
  return 'markdown';
}

export function EditorPanel({ filePath, rootPath, isDark, enableTemplateVars = false, onSave }: EditorPanelProps) {
  const [body, setBody] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<SaveStatus>('idle');

  // ─── Refs (kept fresh for effects / handlers) ───
  const filePathRef = useRef(filePath);
  const bodyRef = useRef(body);
  const savedRef = useRef(savedContent);
  const onSaveRef = useRef(onSave);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Path of the file whose content is currently loaded into `body`/`savedContent`.
  // Only set at the end of a successful load; the auto-save flush refuses to write
  // until this matches the current `filePath`, which prevents the previous file's
  // body from being written to a newly-selected file while its load is in flight.
  const loadedPathRef = useRef<string | undefined>(undefined);
  filePathRef.current = filePath;
  bodyRef.current = body;
  savedRef.current = savedContent;
  onSaveRef.current = onSave;

  const language = filePath ? detectLanguage(filePath) : 'markdown';
  const dirty = !!filePath && body !== savedContent;

  // ─── Core flush: write current body to `targetPath` (or the current file). ───
  const flush = useCallback(async (targetPath?: string): Promise<void> => {
    const path = targetPath ?? filePathRef.current;
    if (!path) return;
    const content = bodyRef.current;
    // Refuse to write until the body actually belongs to `path`. Without this
    // guard, a pending debounce scheduled while loading a new file would write
    // the previous file's body to the new file. `loadedPathRef` is only set
    // after a successful read.
    if (path !== loadedPathRef.current) return;
    if (path !== filePathRef.current) return;
    if (content === savedRef.current) return;
    setStatus('saving');
    try {
      await vfs.writeFile(path, content);
      // Only commit UI state if the file is still current.
      if (path === filePathRef.current) {
        setSavedContent(content);
        setStatus('saved');
      }
      onSaveRef.current?.();
    } catch (err) {
      console.error('[EditorPanel] autosave failed', err);
      setStatus('error');
      toast.error(t('settings.editor.saveFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  // ─── Load file whenever filePath changes. Flush previous on switch. ───
  useEffect(() => {
    // Flush any pending debounce for the previous file before loading the new one.
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }

    if (!filePath) {
      loadedPathRef.current = undefined;
      setBody('');
      setSavedContent('');
      setStatus('idle');
      return;
    }

    let cancelled = false;
    setLoading(true);
    setStatus('idle');
    // Mark the loaded path as stale until the new read completes; this blocks
    // the auto-save effect from writing during the load window.
    loadedPathRef.current = undefined;
    (async () => {
      try {
        const raw = await vfs.readFile(filePath, 'utf8');
        const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
        if (cancelled || filePath !== filePathRef.current) return;
        setSavedContent(content);
        setBody(content);
        loadedPathRef.current = filePath;
      } catch {
        if (cancelled) return;
        setBody('');
        setSavedContent('');
        loadedPathRef.current = filePath;
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [filePath]);

  // ─── Debounced auto-save on body change. ───
  useEffect(() => {
    if (!filePath) return;
    if (body === savedContent) return;
    setStatus('idle');
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    const pathAtSchedule = filePath;
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      void flush(pathAtSchedule);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [body, filePath, savedContent, flush]);

  // ─── Ctrl/Cmd+S: immediate flush. ───
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
        }
        void flush();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [flush]);

  // ─── Flush on visibility change / page unload. ───
  // `visibilitychange → hidden` fires on tab switch, minimise, and the normal
  // lifecycle leading up to close — this is the reliable persistence hook for
  // IndexedDB. `beforeunload` is kept as a last-ditch best-effort queue.
  useEffect(() => {
    const maybeFlush = () => {
      if (bodyRef.current !== savedRef.current && filePathRef.current) {
        void flush();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') maybeFlush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', maybeFlush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('beforeunload', maybeFlush);
    };
  }, [flush]);

  // ─── On unmount, flush any pending changes. ───
  useEffect(() => {
    return () => {
      if (bodyRef.current !== savedRef.current && filePathRef.current) {
        void flush(filePathRef.current);
      }
    };
  }, [flush]);

  // ─── Auto-fade "settings.editor.saved" to "idle" after a moment for calm UI. ───
  useEffect(() => {
    if (status !== 'saved') return;
    const t = setTimeout(() => setStatus('idle'), 2000);
    return () => clearTimeout(t);
  }, [status]);

  // ─── Render ───

  if (!filePath) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        {t('settings.editor.selectFile')}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
        {t('common.loading')}
      </div>
    );
  }

  // Compute breadcrumb segments relative to rootPath
  const breadcrumb = (() => {
    const base = rootPath ?? '';
    const rel = base && filePath.startsWith(base + '/') ? filePath.substring(base.length + 1) : filePath;
    return rel.split('/');
  })();

  const statusLabel =
    status === 'saving' ? t('settings.editor.saving')
    : status === 'error' ? t('settings.editor.saveFailed')
    : dirty ? t('settings.editor.unsaved')
    : status === 'saved' ? t('settings.editor.saved')
    : '';

  const statusClass =
    status === 'error' ? 'text-destructive'
    : status === 'saved' ? 'text-muted-foreground'
    : 'text-muted-foreground/70';

  return (
    <div className="flex flex-col h-full">
      {/* Breadcrumb + save status */}
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-border shrink-0 overflow-hidden">
        <div className="flex items-center gap-1 min-w-0 flex-1 text-muted-foreground">
          {breadcrumb.map((seg, i) => (
            <span key={i} className="flex items-center gap-1 min-w-0">
              {i > 0 && <span className="text-muted-foreground/50">/</span>}
              <span className={i === breadcrumb.length - 1 ? 'text-foreground font-medium truncate' : 'truncate'}>{seg}</span>
            </span>
          ))}
        </div>
        {statusLabel && (
          <span className={cn('shrink-0 text-[11px] transition-opacity', statusClass)}>
            {statusLabel}
          </span>
        )}
      </div>

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
    </div>
  );
}

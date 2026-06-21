import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { Download, Loader2, Search, FileText, Folder, X, List } from 'lucide-react';
import { vfs, type VfsSearchResult } from '@/lib/persistence/vfs';
import { useStorageItem } from '@/hooks/useStorageItem';
import { themePreference } from '@/lib/persistence/storage';
import { downloadFile } from '@/lib/utils';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { t } from '@/lib/i18n';
import { applyTheme, resolveTheme } from './lib/theme';
import { MAX_PREVIEW_BYTES, classifyFile, fileExtension, getHashPath, navigateTo } from './lib/path-utils';
import { mimeFor } from '@/lib/content/mime';
import { zipDirectory, zipNameFor } from './lib/download';
import { Breadcrumbs } from './ui/Breadcrumbs';
import { DirView } from './ui/DirView';
import { FileView } from './ui/FileView';
import type { FileMedia, ViewState, AllDocsEntry } from './types';

export default function App() {
  const [theme] = useStorageItem(themePreference, 'system');
  const [themeReady, setThemeReady] = useState(false);
  const [view, setView] = useState<ViewState>({ kind: 'loading' });
  const [isDownloading, setIsDownloading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Ref to track if the current view is a "special" view (search / allDocs)
  // that should not interact with the normal hash-based navigation.
  const specialViewRef = useRef(false);

  // ── Theme sync ──
  useEffect(() => {
    themePreference.getValue().then((val) => {
      applyTheme(resolveTheme(val ?? 'system'));
      setThemeReady(true);
    });
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    applyTheme(resolveTheme(theme));
  }, [theme, themeReady]);

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => applyTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // ── Load path from hash ──
  const loadIdRef = useRef(0);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!themeReady) return;

    function revokeBlobUrl() {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    }

    async function loadPath() {
      const myId = ++loadIdRef.current;
      const p = getHashPath();
      revokeBlobUrl();

      // If the current view is a special view and the hash hasn't changed
      // back to a real path, keep the special view active.
      if (specialViewRef.current) {
        // Only override if hash is not root/default. Same as "don't interrupt
        // a search or all-docs view when the hash changes to itself".
        if (p === '/') return;
        // User navigated to a real path — clear special mode
        specialViewRef.current = false;
      }

      setView({ kind: 'loading' });

      try {
        const st = await vfs.stat(p);
        if (myId !== loadIdRef.current) return;

        if (st.isDirectory()) {
          const names = await vfs.readdir(p);
          if (myId !== loadIdRef.current) return;
          const entries = await Promise.all(
            names.map(async (name) => {
              const childPath = p === '/' ? `/${name}` : `${p}/${name}`;
              try {
                const childStat = await vfs.stat(childPath);
                return { name, isDir: childStat.isDirectory(), size: childStat.size };
              } catch {
                return { name, isDir: false, size: 0 };
              }
            }),
          );
          if (myId !== loadIdRef.current) return;
          setView({ kind: 'dir', path: p, entries });
          return;
        }

        if (st.size > MAX_PREVIEW_BYTES) {
          setView({ kind: 'file', path: p, media: { type: 'tooLarge', size: st.size } });
          return;
        }

        const name = p.split('/').pop() ?? '';
        const ext = fileExtension(name);
        const klass = classifyFile(name);
        let media: FileMedia;

        if (klass === 'text' || klass === 'markdown') {
          const raw = (await vfs.readFile(p, 'utf8')) as unknown as string;
          if (myId !== loadIdRef.current) return;
          media = { type: klass, content: raw, size: st.size };
        } else if (klass === 'image' || klass === 'video' || klass === 'audio') {
          const data = (await vfs.readFile(p)) as unknown as Uint8Array;
          if (myId !== loadIdRef.current) return;
          const mime = mimeFor(ext);
          const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
          blobUrlRef.current = url;
          media = { type: klass, mime, size: st.size, url };
        } else if (klass === 'binary') {
          media = { type: 'binary', size: st.size };
        } else {
          const _exhaustive: never = klass;
          throw new Error(`unreachable file class: ${_exhaustive}`);
        }

        setView({ kind: 'file', path: p, media });
      } catch (err: any) {
        if (myId !== loadIdRef.current) return;
        const message =
          err?.code === 'ENOENT'
            ? t('vfs.pathNotFound', [p])
            : err?.message ?? t('vfs.unknownError');
        setView({ kind: 'error', path: p, message });
      }
    }

    loadPath();
    window.addEventListener('hashchange', loadPath);
    return () => {
      loadIdRef.current++;
      revokeBlobUrl();
      window.removeEventListener('hashchange', loadPath);
    };
  }, [themeReady]);

  // ── Search handler ──
  const handleSearch = useCallback(async (keyword: string) => {
    const trimmed = keyword.trim();
    if (!trimmed) return;

    specialViewRef.current = true;
    setView({ kind: 'loading' });

    try {
      const results: VfsSearchResult[] = await vfs.searchAll(trimmed, '/', 200);
      if (!specialViewRef.current) return; // aborted by navigation

      const entries = results.map((r) => ({
        name: r.name,
        isDir: r.isDir,
        size: r.size,
      }));
      const paths = results.map((r) => r.absPath);

      setView({ kind: 'search', query: trimmed, results: entries, paths });
    } catch (err) {
      console.error('[vfs.search]', err);
      setView({ kind: 'error', path: '/', message: 'Search failed' });
    }
  }, []);

  // ── All Documents handler ──
  const handleAllDocuments = useCallback(async () => {
    specialViewRef.current = true;
    setView({ kind: 'loading' });

    try {
      // Use walkFiles to get all files recursively
      const files = await vfs.walkFiles('/');
      if (!specialViewRef.current) return;

      // Stat each file for size, also walk directories for the listing
      const entries: AllDocsEntry[] = [];
      for (const file of files) {
        if (!specialViewRef.current) return;
        try {
          const st = await vfs.stat(file.absPath);
          entries.push({
            name: file.relPath,
            absPath: file.absPath,
            isDir: false,
            size: st.size,
            modifiedAt: 0, // lightning-fs doesn't expose mtime; sort alphabetically
          });
        } catch {
          entries.push({
            name: file.relPath,
            absPath: file.absPath,
            isDir: false,
            size: 0,
            modifiedAt: 0,
          });
        }
      }

      // Sort alphabetically by path for consistent ordering
      entries.sort((a, b) => a.absPath.localeCompare(b.absPath));

      setView({ kind: 'allDocuments', entries });
    } catch (err) {
      console.error('[vfs.allDocuments]', err);
      setView({ kind: 'error', path: '/', message: 'Failed to list documents' });
    }
  }, []);

  // ── Navigate from search / all-docs result ──
  const handleNavigateTo = useCallback((absPath: string) => {
    specialViewRef.current = false;
    navigateTo(absPath);
  }, []);

  // ── Clear special view ──
  const handleBackToNavigation = useCallback(() => {
    specialViewRef.current = false;
    setSearchQuery('');
    navigateTo('/');
  }, []);

  // ── Download (file or zipped folder) ──
  async function handleDownload() {
    if (isDownloading) return;
    const snapshot = view;
    if (snapshot.kind !== 'file' && snapshot.kind !== 'dir') return;

    setIsDownloading(true);
    try {
      if (snapshot.kind === 'file') {
        const data = (await vfs.readFile(snapshot.path)) as unknown as Uint8Array;
        const name = snapshot.path.split('/').pop() || 'file';
        downloadFile(name, new Blob([data as BlobPart], { type: 'application/octet-stream' }), 'application/octet-stream');
      } else {
        const data = await zipDirectory(snapshot.path);
        downloadFile(zipNameFor(snapshot.path), new Blob([data as BlobPart], { type: 'application/zip' }), 'application/zip');
      }
    } catch (err) {
      console.error('[vfs.download]', err);
      toast.error(t('common.downloadFailed'));
    } finally {
      setIsDownloading(false);
    }
  }

  // ── Render ──

  if (!themeReady) return null;

  const currentPath = view.kind !== 'loading' && view.kind !== 'search' && view.kind !== 'allDocuments'
    ? view.path
    : getHashPath();

  const isSpecialView = view.kind === 'search' || view.kind === 'allDocuments';

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen bg-background text-foreground">
        {/* Header */}
        <header className="flex items-center gap-4 px-5 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-base font-semibold tracking-tight">VFS</span>
            <span className="text-xs text-muted-foreground/50 font-mono">cebian</span>
          </div>
          <div className="h-4 w-px bg-border shrink-0" />
          <div className="flex-1 min-w-0">
            {isSpecialView ? (
              <button
                onClick={handleBackToNavigation}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                ← {t('vfs.backToRoot')}
              </button>
            ) : (
              <Breadcrumbs path={currentPath} />
            )}
          </div>
          {/* Search toggle + action buttons */}
          <div className="flex items-center gap-1 shrink-0">
            {/* Search button — opens search bar inline */}
            <button
              onClick={() => {
                const input = document.querySelector<HTMLInputElement>('[data-vfs-search]');
                if (input) {
                  input.focus();
                  input.select();
                }
              }}
              title={t('vfs.searchPlaceholder')}
              aria-label={t('vfs.searchPlaceholder')}
              className="shrink-0 size-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <Search className="size-4" />
            </button>
            {/* All Documents button */}
            <button
              onClick={handleAllDocuments}
              disabled={view.kind === 'loading'}
              title={t('vfs.allDocuments')}
              aria-label={t('vfs.allDocuments')}
              className="shrink-0 size-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
            >
              <List className="size-4" />
            </button>
            {!isSpecialView && (view.kind === 'file' || view.kind === 'dir' || isDownloading) && (
              <button
                onClick={handleDownload}
                disabled={isDownloading}
                title={isDownloading ? t('vfs.zipping') : t('common.download')}
                aria-label={isDownloading ? t('vfs.zipping') : t('common.download')}
                className="shrink-0 size-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
              >
                {isDownloading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Download className="size-4" />
                )}
              </button>
            )}
          </div>
        </header>

        {/* Search bar */}
        <div className="px-5 py-2 border-b border-border">
          <div className="max-w-3xl mx-auto relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground/60 pointer-events-none" />
            <input
              data-vfs-search
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSearch(searchQuery);
                }
                if (e.key === 'Escape') {
                  setSearchQuery('');
                  if (isSpecialView) handleBackToNavigation();
                }
              }}
              placeholder={t('vfs.searchPlaceholder')}
              className="w-full pl-9 pr-8 py-1.5 text-sm bg-muted/50 border border-border rounded-md
                text-foreground placeholder:text-muted-foreground/40
                focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary/30
                transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => {
                  setSearchQuery('');
                  if (isSpecialView) handleBackToNavigation();
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 size-5 inline-flex items-center justify-center
                  rounded text-muted-foreground/50 hover:text-foreground hover:bg-accent transition-colors"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Main content */}
        <main className="flex-1 min-h-0 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-5 py-5">
            {view.kind === 'loading' && (
              <div className="flex items-center justify-center py-20">
                <div className="h-5 w-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              </div>
            )}

            {view.kind === 'dir' && <DirView path={view.path} entries={view.entries} />}

            {view.kind === 'file' && <FileView path={view.path} media={view.media} />}

            {view.kind === 'search' && (
              <SearchResultsView
                query={view.query}
                entries={view.results}
                paths={view.paths}
                onNavigate={handleNavigateTo}
              />
            )}

            {view.kind === 'allDocuments' && (
              <AllDocumentsView
                entries={view.entries}
                onNavigate={handleNavigateTo}
              />
            )}

            {view.kind === 'error' && (
              <div className="flex flex-col items-center justify-center py-20 gap-3">
                <div className="h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
                  <span className="text-destructive text-lg">!</span>
                </div>
                <p className="text-sm text-muted-foreground">{view.message}</p>
                <button
                  onClick={() => navigateTo('/')}
                  className="mt-2 text-xs text-primary hover:underline"
                >
                  {t('vfs.backToRoot')}
                </button>
              </div>
            )}
          </div>
        </main>
        <Toaster theme={resolveTheme(theme)} />
      </div>
    </TooltipProvider>
  );
}

// ─── Search Results View ───

function SearchResultsView({
  query,
  entries,
  paths,
  onNavigate,
}: {
  query: string;
  entries: { name: string; isDir: boolean; size: number }[];
  paths: string[];
  onNavigate: (absPath: string) => void;
}) {
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
        <Search size={48} strokeWidth={1} className="opacity-30" />
        <span className="text-sm">{t('vfs.noResults')}</span>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-sm font-semibold">{t('vfs.searchResults')}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('vfs.searchResultCount', [String(entries.length)])}
        </span>
      </div>
      <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
        {entries.map((entry, i) => {
          const fullPath = paths[i];
          // Determine relative display path by stripping the file/dir name
          const parentDir = fullPath.lastIndexOf('/') > 0
            ? fullPath.slice(0, fullPath.lastIndexOf('/'))
            : '/';
          return (
            <button
              key={fullPath}
              onClick={() => onNavigate(fullPath)}
              className="group w-full flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors text-left"
            >
              {entry.isDir ? (
                <Folder size={18} strokeWidth={1.5} className="shrink-0 text-primary/80 group-hover:text-primary transition-colors" />
              ) : (
                <FileText size={18} strokeWidth={1.5} className="shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
              )}
              <div className="flex-1 min-w-0">
                <span className="text-sm truncate block text-foreground/90 group-hover:text-foreground transition-colors">
                  {entry.name}
                </span>
                <span className="text-xs text-muted-foreground/60 truncate block">
                  {parentDir}
                </span>
              </div>
              {!entry.isDir && (
                <span className="shrink-0 text-xs text-muted-foreground/60 tabular-nums">
                  {formatEntrySize(entry.size)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── All Documents View ───

function AllDocumentsView({
  entries,
  onNavigate,
}: {
  entries: AllDocsEntry[];
  onNavigate: (absPath: string) => void;
}) {
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
        <FileText size={48} strokeWidth={1} className="opacity-30" />
        <span className="text-sm">{t('common.empty.folder')}</span>
      </div>
    );
  }

  // Group by top-level directory for readability
  const dirs = new Map<string, AllDocsEntry[]>();
  for (const entry of entries) {
    const topDir = entry.absPath.split('/')[1] || '(root)';
    const group = dirs.get(topDir);
    if (group) group.push(entry);
    else dirs.set(topDir, [entry]);
  }

  const sortedDirs = [...dirs.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-sm font-semibold">{t('vfs.allDocuments')}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('vfs.searchResultCount', [String(entries.length)])}
        </span>
      </div>
      {sortedDirs.map(([topDir, groupEntries]) => (
        <div key={topDir} className="mb-6">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 px-1">
            /{topDir}
          </h3>
          <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
            {groupEntries.map((entry) => (
              <button
                key={entry.absPath}
                onClick={() => onNavigate(entry.absPath)}
                className="group w-full flex items-center gap-3 px-4 py-2 hover:bg-accent/50 transition-colors text-left"
              >
                <FileText size={16} strokeWidth={1.5} className="shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm truncate block text-foreground/90 group-hover:text-foreground transition-colors">
                    {entry.name}
                  </span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground/60 tabular-nums">
                  {formatEntrySize(entry.size)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatEntrySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

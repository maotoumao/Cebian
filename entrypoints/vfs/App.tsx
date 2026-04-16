import { useState, useEffect } from 'react';
import { vfs, normalizePath } from '@/lib/vfs';
import { useStorageItem } from '@/hooks/useStorageItem';
import { themePreference } from '@/lib/storage';

// ─── Theme (same as ai-config) ───

function resolveTheme(pref: 'dark' | 'light' | 'system'): 'dark' | 'light' {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(resolved: 'dark' | 'light') {
  if (resolved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

// ─── Types ───

interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'dir'; path: string; entries: DirEntry[] }
  | { kind: 'file'; path: string; content: string; size: number }
  | { kind: 'error'; path: string; message: string };

// ─── Helpers ───

function getHashPath(): string {
  const raw = window.location.hash.slice(1); // strip leading #
  return normalizePath(decodeURIComponent(raw) || '/');
}

function navigateTo(path: string) {
  window.location.hash = '#' + encodeURIComponent(path);
}

function parentOf(p: string): string {
  if (p === '/') return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

const BINARY_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'pdf', 'zip', 'gz', 'tar', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'wav', 'ogg']);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

// ─── Icons ───

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  );
}

function FileIcon({ ext, className }: { ext: string; className?: string }) {
  const isCode = ['ts', 'tsx', 'js', 'jsx', 'json', 'css', 'html'].includes(ext);
  const isMd = ext === 'md';
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      {isCode && <path d="m10 13-2 2 2 2M14 17l2-2-2-2" />}
      {isMd && <path d="M9 13h6M9 17h4" />}
    </svg>
  );
}

function ChevronRight({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function ArrowUp({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </svg>
  );
}

// ─── Breadcrumbs ───

function Breadcrumbs({ path }: { path: string }) {
  const segments = path === '/' ? [] : path.split('/').filter(Boolean);

  return (
    <nav className="flex items-center gap-0.5 text-sm font-mono overflow-x-auto min-w-0 scrollbar-none">
      <button
        onClick={() => navigateTo('/')}
        className="shrink-0 px-1.5 py-0.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        /
      </button>
      {segments.map((seg, i) => {
        const segPath = '/' + segments.slice(0, i + 1).join('/');
        const isLast = i === segments.length - 1;
        return (
          <span key={segPath} className="flex items-center gap-0.5 min-w-0">
            <ChevronRight className="shrink-0 text-muted-foreground/40" />
            {isLast ? (
              <span className="text-foreground font-medium truncate">{seg}</span>
            ) : (
              <button
                onClick={() => navigateTo(segPath)}
                className="px-1.5 py-0.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors truncate max-w-48"
              >
                {seg}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

// ─── Directory listing ───

function DirView({ path, entries }: { path: string; entries: DirEntry[] }) {
  const dirs = entries.filter((e) => e.isDir).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((e) => !e.isDir).sort((a, b) => a.name.localeCompare(b.name));
  const sorted = [...dirs, ...files];
  const showUpNav = path !== '/';

  if (sorted.length === 0 && !showUpNav) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-3">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" className="opacity-30">
          <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
        </svg>
        <span className="text-sm">空目录</span>
      </div>
    );
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
      {showUpNav && (
        <button
          onClick={() => navigateTo(parentOf(path))}
          className="group w-full flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors text-left"
        >
          <ArrowUp className="text-muted-foreground group-hover:text-primary transition-colors" />
          <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">..</span>
        </button>
      )}
      {sorted.map((entry, i) => {
        const fullPath = path === '/' ? `/${entry.name}` : `${path}/${entry.name}`;
        const ext = fileExtension(entry.name);
        return (
          <button
            key={entry.name}
            onClick={() => navigateTo(fullPath)}
            className="group w-full flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors text-left"
          >
            {entry.isDir ? (
              <FolderIcon className="shrink-0 text-primary/80 group-hover:text-primary transition-colors" />
            ) : (
              <FileIcon ext={ext} className="shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
            )}
            <span className="flex-1 text-sm truncate text-foreground/90 group-hover:text-foreground transition-colors">
              {entry.name}
            </span>
            {!entry.isDir && (
              <span className="shrink-0 text-xs text-muted-foreground/60 tabular-nums">
                {formatSize(entry.size)}
              </span>
            )}
            {entry.isDir && (
              <ChevronRight className="shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors" />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── File viewer ───

function FileView({ path, content, size }: { path: string; content: string; size: number }) {
  const name = path.split('/').pop() ?? path;
  const ext = fileExtension(name);
  const lineCount = content.length === 0 ? 0 : content.split('\n').length;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* File header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-card border-b border-border">
        <div className="flex items-center gap-2.5 min-w-0">
          <FileIcon ext={ext} className="shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium truncate">{name}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
          <span className="tabular-nums">{lineCount} 行</span>
          <span className="text-border">·</span>
          <span className="tabular-nums">{formatSize(size)}</span>
        </div>
      </div>
      {/* Content */}
      <div className="relative overflow-auto max-h-[calc(100vh-12rem)]">
        <pre className="p-4 text-[13px] leading-relaxed font-mono text-foreground/90 whitespace-pre-wrap wrap-break-word selection:bg-primary/20">
          {content}
        </pre>
      </div>
    </div>
  );
}

// ─── Main App ───

export default function App() {
  const [theme] = useStorageItem(themePreference, 'system');
  const [themeReady, setThemeReady] = useState(false);
  const [view, setView] = useState<ViewState>({ kind: 'loading' });

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
  useEffect(() => {
    if (!themeReady) return;
    let stale = false;

    async function loadPath() {
      const p = getHashPath();
      setView({ kind: 'loading' });

      try {
        const st = await vfs.stat(p);

        if (st.isDirectory()) {
          const names = await vfs.readdir(p);
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

          if (!stale) setView({ kind: 'dir', path: p, entries });
        } else {
          const ext = fileExtension(p.split('/').pop() ?? '');
          if (BINARY_EXTS.has(ext)) {
            if (!stale) setView({ kind: 'file', path: p, content: `[二进制文件 — ${formatSize(st.size)}]`, size: st.size });
          } else {
            const raw = (await vfs.readFile(p, 'utf8')) as unknown as string;
            if (!stale) setView({ kind: 'file', path: p, content: raw, size: st.size });
          }
        }
      } catch (err: any) {
        if (stale) return;
        const message =
          err?.code === 'ENOENT'
            ? `路径不存在: ${p}`
            : err?.message ?? '未知错误';
        setView({ kind: 'error', path: p, message });
      }
    }

    loadPath();
    window.addEventListener('hashchange', loadPath);
    return () => {
      stale = true;
      window.removeEventListener('hashchange', loadPath);
    };
  }, [themeReady]);

  // ── Render ──

  if (!themeReady) return null;

  const currentPath = view.kind !== 'loading' ? view.path : getHashPath();

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      {/* Header */}
      <header className="flex items-center gap-4 px-5 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold tracking-tight">VFS</span>
          <span className="text-xs text-muted-foreground/50 font-mono">cebian</span>
        </div>
        <div className="h-4 w-px bg-border" />
        <Breadcrumbs path={currentPath} />
      </header>

      {/* Main content */}
      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-5">
          {view.kind === 'loading' && (
            <div className="flex items-center justify-center py-20">
              <div className="h-5 w-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
            </div>
          )}

          {view.kind === 'dir' && <DirView path={view.path} entries={view.entries} />}

          {view.kind === 'file' && <FileView path={view.path} content={view.content} size={view.size} />}

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
                返回根目录
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

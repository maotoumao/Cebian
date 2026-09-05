import { useState, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { vfs } from '@/lib/persistence/vfs';
import { useStorageItem } from '@/hooks/useStorageItem';
import { themePreference } from '@/lib/persistence/storage';
import { downloadFile } from '@/lib/utils';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { Spinner } from '@/components/ui/spinner';
import { t } from '@/lib/i18n';
import { applyTheme, resolveTheme } from './lib/theme';
import { dualViewTypeOf, getHashPath, navigateTo, sessionUuidOf, workspaceUuidOf } from './lib/path-utils';
import { zipDirectory, zipNameFor } from './lib/download';
import { buildCrumbs } from './lib/breadcrumb';
import { loadView, releaseView } from './lib/load-view';
import { Breadcrumbs } from './ui/Breadcrumbs';
import { DirView } from './ui/DirView';
import { FileView } from './ui/FileView';
import { Toolbar } from './ui/Toolbar';
import type { DualViewType, ViewMode, ViewState } from './types';

const BRAND_ICON = browser.runtime.getURL('/icon/32.png' as never);

export default function App() {
  const [theme] = useStorageItem(themePreference, 'system');
  const [themeReady, setThemeReady] = useState(false);
  const [view, setView] = useState<ViewState>({ kind: 'loading', path: getHashPath() });
  // 下载忙碌标志放在 `view` 之外：在 `/prompts` 上发起的打包即使用户中途导航走了也
  // 必须继续（显式下载不打断）。handler 在点击时从闭包捕获目标路径，与后续 view 无关。
  const [isDownloading, setIsDownloading] = useState(false);
  // 预览 / 源码切换按文件类型各自记忆：连续浏览多个 .md 时保持用户选的视图，
  // 切到别的双视图类型互不影响。内存态，不持久化。
  const [viewModes, setViewModes] = useState<Partial<Record<DualViewType, ViewMode>>>({});

  // ── 主题同步 ──
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

  // ── 按 hash 加载路径 ──
  //
  // 两份跨调用状态放在 ref 里：
  //   1. `loadIdRef`：每次 loadPath 进入时取一个递增 id，await 之后重新核对；连续多次
  //      hashchange（或上一次尚未完成时又来一次）不会让过期结果覆盖新结果。
  //   2. `heldRef`：当前持有外部资源（blob URL / pdf.js 文档）的视图，换视图前 / 卸载时
  //      经 `releaseView` 释放，内存有界。
  const loadIdRef = useRef(0);
  const heldRef = useRef<ViewState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!themeReady) return;

    function releaseHeld() {
      if (heldRef.current) {
        releaseView(heldRef.current);
        heldRef.current = null;
      }
    }

    async function loadPath() {
      const myId = ++loadIdRef.current;
      // 作废上一次仍在飞的加载：结果会被 loadIdRef 丢弃，abort 让它别再做重活。
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const path = getHashPath();
      // 加载态继承上一视图的会话标签（仍在同一会话内时），面包屑不会闪成「未知会话」。
      setView((prev) => ({
        kind: 'loading',
        path,
        session: prev.session?.id === sessionUuidOf(path) ? prev.session : undefined,
      }));
      const next = await loadView(path, controller.signal);
      if (myId !== loadIdRef.current) {
        // 已被更新的导航作废：把这次加载创建的资源直接释放。
        releaseView(next);
        return;
      }
      releaseHeld();
      heldRef.current = next;
      setView(next);
    }

    loadPath();
    window.addEventListener('hashchange', loadPath);
    return () => {
      loadIdRef.current++;
      abortRef.current?.abort();
      releaseHeld();
      window.removeEventListener('hashchange', loadPath);
    };
  }, [themeReady]);

  // ── 下载（文件或打包的文件夹）──
  //
  // 第一个 await 之前把 `view` 快照成常量，避免并发 hashchange 把下载导向别的路径。
  // 有意不在导航时中止——见 `isDownloading` 的声明注释。
  async function handleDownload() {
    if (isDownloading) return;
    const snapshot = view;
    if (snapshot.kind !== 'file' && snapshot.kind !== 'dir') return;

    setIsDownloading(true);
    try {
      if (snapshot.kind === 'file') {
        const data = (await vfs.readFile(snapshot.path)) as unknown as Uint8Array;
        const name = snapshot.path.split('/').pop() || 'file';
        // 包成 Blob——`downloadFile` 接受 ArrayBuffer/Blob/string 而不直接接受 Uint8Array。
        // `as BlobPart` 见 load-view.ts 同处注释。通用 octet-stream 防止浏览器改写扩展名
        // （如 .md → .txt）。
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

  // ── 渲染 ──

  // 加载态且没有继承到会话标签时，会话段只显示短 ID（标签还没查回来，不是会话已删）。
  const crumbs = useMemo(
    () =>
      buildCrumbs(
        view.path,
        view.kind === 'dir' ? true : view.kind === 'file' ? false : undefined,
        view.kind === 'loading' && !view.session ? 'pending' : view.session,
      ),
    [view],
  );
  const dualType: DualViewType | null = view.kind === 'file' ? dualViewTypeOf(view.media) : null;
  const mode: ViewMode = (dualType ? viewModes[dualType] : undefined) ?? 'preview';

  if (!themeReady) return null;

  // 主区域是滚动容器；填满型视图（媒体 / 占位 / HTML 预览）用 absolute inset-0 铺满它，
  // PDF 视图为了做 IntersectionObserver 的 root 自带一层滚动容器。
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen bg-background text-foreground">
        <header className="flex items-center gap-3 pl-3 pr-3.5 h-[46px] border-b border-border shrink-0">
          <img src={BRAND_ICON} alt="Cebian" title="Cebian" className="size-6 rounded-md shrink-0" />
          <div className="h-4 w-px bg-border shrink-0" />
          <div className="flex-1 min-w-0">
            <Breadcrumbs crumbs={crumbs} />
          </div>
          <Toolbar
            view={view}
            mode={dualType ? mode : undefined}
            onModeChange={(next) => dualType && setViewModes((prev) => ({ ...prev, [dualType]: next }))}
            isDownloading={isDownloading}
            onDownload={handleDownload}
          />
        </header>

        <main className="flex-1 min-h-0 overflow-auto relative">
          {view.kind === 'loading' && (
            <div className="flex items-center justify-center py-20">
              <Spinner className="size-5 text-primary" aria-label={t('common.loading')} />
            </div>
          )}

          {view.kind === 'dir' && (
            <div className="max-w-3xl mx-auto px-5 py-5">
              <DirView
                path={view.path}
                entries={view.entries}
                workspaceLabels={view.workspaceLabels}
                workspaceRow={workspaceUuidOf(view.path) ? view.session : undefined}
              />
            </div>
          )}

          {view.kind === 'file' && <FileView path={view.path} media={view.media} mode={mode} />}

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
        </main>
        <Toaster theme={resolveTheme(theme)} />
      </div>
    </TooltipProvider>
  );
}

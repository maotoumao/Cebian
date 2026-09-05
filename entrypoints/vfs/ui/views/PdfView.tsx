import { useEffect, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { Spinner } from '@/components/ui/spinner';
import { t } from '@/lib/i18n';
import { Placeholder } from './Placeholder';

/** 缩放档位（相对 pdf.js 的 CSS 像素 1:1）。下端给到 0.25，让 A0 图纸这类大幅面也能贴合窄容器。 */
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];
/** 「贴合宽度」的初始缩放上限：再大字号也不会一上来就 200%。 */
const FIT_MAX_SCALE = 1.5;
/** 页与页之间、页与容器边缘的间距（px）。 */
const PAGE_GAP = 16;
/** 视口上下各多少像素算「附近」：进入即渲染，离开即释放位图。 */
const RENDER_MARGIN = '800px';
/** 当前页判定用的交叉阈值：足够密，页面比视口高时页码也能及时切换。 */
const PAGE_THRESHOLDS = Array.from({ length: 21 }, (_, i) => i / 20);

interface PageBox {
  /** 1-based 页号。 */
  index: number;
  /** 未缩放（scale = 1）时的 CSS 像素尺寸，用于在渲染前就撑出占位高度。 */
  width: number;
  height: number;
}

/** pdf.js 取消渲染时抛的异常名；用 name 判断，避免把 pdf.js 运行时静态引进主 chunk。 */
const RENDER_CANCELLED = 'RenderingCancelledException';

async function measurePage(doc: PDFDocumentProxy, index: number): Promise<PageBox> {
  const page = await doc.getPage(index);
  const { width, height } = page.getViewport({ scale: 1 });
  return { index, width, height };
}

/** 贴合容器宽度的档位：不超过 fit 的最大档，最小回落到第 0 档。 */
function fitZoomIndex(containerWidth: number, pageWidth: number): number {
  const fit = Math.min((containerWidth - PAGE_GAP * 2) / pageWidth, FIT_MAX_SCALE);
  let idx = 0;
  ZOOM_STEPS.forEach((s, i) => { if (s <= fit) idx = i; });
  return idx;
}

/** 单页：进入视口附近才渲染到 canvas，离开就把位图释放（`width = 0`）只留占位尺寸；
 *  滚一遍长文档不会把所有页都驻留在内存里。 */
function PdfPage({ doc, box, scale, root }: { doc: PDFDocumentProxy; box: PageBox; scale: number; root: HTMLElement }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => setNear(e.isIntersecting)),
      { root, rootMargin: RENDER_MARGIN },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [root]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!near) {
      // 释放位图（backing store），CSS 尺寸由 style 保持，占位不变。
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    let task: RenderTask | null = null;
    let cancelled = false;

    (async () => {
      try {
        const page = await doc.getPage(box.index);
        if (cancelled) return;
        const viewport = page.getViewport({ scale });
        // 按设备像素比渲染，高分屏上文字才不发虚；CSS 尺寸仍按逻辑像素。
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        task = page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
        await task.promise;
      } catch (err) {
        // 取消（换缩放 / 离开视口 / 卸载）与文档被 App 销毁都是正常路径，只记录真正的渲染错误。
        if (cancelled || (err as { name?: string })?.name === RENDER_CANCELLED) return;
        console.warn('[vfs.pdf] page render failed', box.index, err);
      }
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, box.index, scale, near]);

  return (
    <canvas
      ref={canvasRef}
      data-page={box.index}
      className="block mx-auto bg-white shadow-[0_1px_3px_rgba(0,0,0,.12),0_8px_24px_-14px_rgba(0,0,0,.4)]"
      style={{ width: box.width * scale, height: box.height * scale, marginBottom: PAGE_GAP }}
      aria-label={t('vfs.pageIndicator', [String(box.index), String(doc.numPages)])}
    />
  );
}

interface Layout {
  boxes: PageBox[];
  zoomIndex: number;
}

/** PDF 视图：pdf.js 按页画 canvas，纵向排列填满主区域，底部浮动「第 N / M 页 · 缩放」胶囊。
 *  文档句柄由加载器打开、App 释放（与 blob URL 同一套所有权），这里只负责渲染。
 *
 *  首屏策略：先只量第一页，用它的尺寸给全部页面撑出占位并算好贴合宽度的初始缩放，一次性
 *  提交（不会先按 100% 画一帧再跳）；其余页面并行量完后再修正占位。 */
function PdfView({ doc }: { doc: PDFDocumentProxy }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [failed, setFailed] = useState(false);
  const [current, setCurrent] = useState(1);

  useEffect(() => {
    if (!root) return;
    let alive = true;
    (async () => {
      try {
        const first = await measurePage(doc, 1);
        if (!alive) return;
        const provisional = Array.from({ length: doc.numPages }, (_, i) => ({ ...first, index: i + 1 }));
        setLayout({ boxes: provisional, zoomIndex: fitZoomIndex(root.clientWidth, first.width) });

        const rest = await Promise.all(
          Array.from({ length: doc.numPages - 1 }, (_, i) => measurePage(doc, i + 2)),
        );
        if (!alive) return;
        setLayout((prev) => (prev ? { ...prev, boxes: [first, ...rest] } : prev));
      } catch (err) {
        // 卸载 / 文档已被 App 销毁时的失败是正常路径；仍挂载时的失败才是真错误，显示占位。
        if (!alive) return;
        console.warn('[vfs.pdf] failed to measure pages', err);
        setFailed(true);
      }
    })();
    return () => { alive = false; };
  }, [doc, root]);

  // 当前页 = 视口内露出高度最大的那一页（按像素比，页面尺寸不一时也公平）。
  useEffect(() => {
    if (!root || !layout) return;
    const visiblePx = new Map<number, number>();
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => visiblePx.set(Number((e.target as HTMLElement).dataset.page), e.intersectionRect.height));
        let best = 1;
        let bestPx = -1;
        visiblePx.forEach((px, page) => { if (px > bestPx) { bestPx = px; best = page; } });
        setCurrent(best);
      },
      { root, threshold: PAGE_THRESHOLDS },
    );
    root.querySelectorAll('canvas[data-page]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [root, layout]);

  const zoomIndex = layout?.zoomIndex ?? 0;
  const scale = ZOOM_STEPS[zoomIndex];
  const setZoom = (delta: number) =>
    setLayout((prev) => prev && { ...prev, zoomIndex: Math.min(ZOOM_STEPS.length - 1, Math.max(0, prev.zoomIndex + delta)) });

  const hud = (
      <div className="absolute bottom-3.5 left-1/2 -translate-x-1/2 flex items-center gap-2 pl-3 pr-1.5 py-1 rounded-full bg-popover border border-border shadow-lg text-xs tabular-nums">
        <span>{t('vfs.pageIndicator', [String(current), String(doc.numPages)])}</span>
        <div className="h-4 w-px bg-border" />
        <button type="button" aria-label={t('vfs.zoomOut')} disabled={zoomIndex === 0} onClick={() => setZoom(-1)} className="size-6 inline-flex items-center justify-center rounded-full hover:bg-accent disabled:opacity-40">
          <Minus className="size-3.5" />
        </button>
        <span className="w-10 text-center">{Math.round(scale * 100)}%</span>
        <button type="button" aria-label={t('vfs.zoomIn')} disabled={zoomIndex === ZOOM_STEPS.length - 1} onClick={() => setZoom(1)} className="size-6 inline-flex items-center justify-center rounded-full hover:bg-accent disabled:opacity-40">
          <Plus className="size-3.5" />
        </button>
      </div>
  );

  if (failed) return <Placeholder message={t('errors.pdfRenderFailed')} />;

  return (
    <div className="absolute inset-0">
      <div ref={setRoot} className="absolute inset-0 overflow-auto bg-muted" style={{ padding: PAGE_GAP }}>
        {root && layout?.boxes.map((box) => (
          <PdfPage key={box.index} doc={doc} box={box} scale={scale} root={root} />
        ))}
      </div>
      {!layout && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Spinner className="size-5 text-primary" aria-label={t('common.loading')} />
        </div>
      )}
      {layout && hud}
    </div>
  );
}

export { PdfView };

/**
 * VFS 页面的加载器：把一个路径解析成可渲染的 `ViewState`。
 *
 * 从 App.tsx 抽出来，让 App 只管状态编排。这里不持有任何状态；media 用到的外部资源
 * （blob URL、pdf.js 文档）由本文件创建、由 App 调 `releaseView` 释放，因为只有 App 知道
 * 一次加载是否已经被更新的导航作废。
 */
import { vfs } from '@/lib/persistence/vfs';
import { loadPdfJs } from '@/lib/content/pdf-loader';
import { mimeFor } from '@/lib/content/mime';
import { t } from '@/lib/i18n';
import {
  MAX_PREVIEW_BYTES,
  classifyFile,
  codeLanguageOf,
  fileExtension,
  isWorkspacesRoot,
  sessionUuidOf,
} from './path-utils';
import { resolveWorkspaceLabels } from './session-labels';
import type { SessionLabelRow } from '@/lib/persistence/db';
import type { DirEntry, FileMedia, ImageDimensions, ViewState } from '../types';

async function loadDir(p: string, session: SessionLabelRow | undefined): Promise<ViewState> {
  const names = await vfs.readdir(p);
  const entries: DirEntry[] = await Promise.all(
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

  // 工作区根 `/workspaces`：把 UUID 子目录翻译成「会话标题 · 日期」。
  if (isWorkspacesRoot(p)) {
    const uuids = entries.filter((e) => e.isDir).map((e) => e.name);
    const workspaceLabels = await resolveWorkspaceLabels(uuids);
    return { kind: 'dir', path: p, entries, workspaceLabels };
  }
  return { kind: 'dir', path: p, entries, session };
}

/** 路径位于某个会话工作区之下时解析该会话的标签行（面包屑 / 目录信息条共用）。 */
async function loadSession(p: string) {
  const uuid = sessionUuidOf(p);
  if (!uuid) return undefined;
  try {
    const labels = await resolveWorkspaceLabels([uuid]);
    return labels.get(uuid);
  } catch (err) {
    // 标签只是锦上添花：查库失败不该让文件本身打不开（也避免并行创建的 blob URL 泄漏）。
    console.warn('[vfs.load-view] session label lookup failed', err);
    return undefined;
  }
}

async function loadFileMedia(p: string, size: number, signal: AbortSignal): Promise<FileMedia> {
  // 所有类型共用一个体积上限：50 MB 的 markdown 和 50 MB 的图片一样难渲染，
  // 占位提示仍让用户可以回落到下载。
  if (size > MAX_PREVIEW_BYTES) return { type: 'tooLarge', size };

  const name = p.split('/').pop() ?? '';
  const ext = fileExtension(name);
  const klass = classifyFile(name);

  if (klass === 'text' || klass === 'markdown') {
    const raw = (await vfs.readFile(p, 'utf8')) as unknown as string;
    return { type: klass, content: raw, lines: countLines(raw), size };
  }
  if (klass === 'code') {
    const raw = (await vfs.readFile(p, 'utf8')) as unknown as string;
    // classifyFile 已保证 ext 在表里，这里的 `?? ext` 只是给 TS 的兜底。
    return { type: 'code', lang: codeLanguageOf(ext) ?? ext, content: raw, lines: countLines(raw), size };
  }
  if (klass === 'html') {
    const raw = (await vfs.readFile(p, 'utf8')) as unknown as string;
    return { type: 'html', content: raw, lines: countLines(raw), size };
  }
  if (klass === 'svg') {
    // 源码与预览都要：源码按 utf8 解码，预览用同一份字节建 blob URL。
    const data = (await vfs.readFile(p)) as unknown as Uint8Array;
    const raw = new TextDecoder().decode(data);
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mimeFor(ext) }));
    const dimensions = await readImageDimensions(url);
    return { type: 'svg', content: raw, lines: countLines(raw), size, url, dimensions };
  }
  if (klass === 'pdf') return loadPdf(p, size, signal);
  if (klass === 'image' || klass === 'video' || klass === 'audio') {
    const data = (await vfs.readFile(p)) as unknown as Uint8Array;
    const mime = mimeFor(ext);
    // `as BlobPart`：TS DOM lib 把 Uint8Array 标成 `Uint8Array<ArrayBufferLike>`，
    // BlobPart 的 ArrayBufferView 约束不直接接受，但 vfs 给的一定是普通 ArrayBuffer。
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
    if (klass === 'image') return { type: 'image', mime, size, url, dimensions: await readImageDimensions(url) };
    return { type: klass, mime, size, url };
  }
  if (klass === 'binary') return { type: 'binary', size };

  // 穷尽性守卫：classifyFile 的返回联合新增成员时由 TS 报错，而不是运行时漏渲染。
  const _exhaustive: never = klass;
  throw new Error(`unreachable file class: ${_exhaustive}`);
}

/** 打开 PDF。pdf.js 与 worker 在首次打开时才懒加载（独立 chunk）。`data` 的底层 ArrayBuffer
 *  会被转移给 worker，之后不要再读它。
 *  loadingTask 是 pdf.js 6 唯一的销毁入口：解析失败时必须由这里销毁（否则 worker 侧泄漏，
 *  App 的 `releaseView` 也拿不到它）；导航已作废（`signal`）时同样立即销毁，不让一个 50 MB 的
 *  旧 PDF 继续解析到底。 */
async function loadPdf(p: string, size: number, signal: AbortSignal): Promise<FileMedia> {
  signal.throwIfAborted();
  const data = (await vfs.readFile(p)) as unknown as Uint8Array;
  signal.throwIfAborted();
  const pdfjs = await loadPdfJs();
  signal.throwIfAborted();
  const loadingTask = pdfjs.getDocument({ data, verbosity: 0 });
  // 销毁只做一次：abort 与解析失败可能先后都想销毁，共用同一个 promise。
  let destroying: Promise<void> | null = null;
  const destroy = () =>
    (destroying ??= loadingTask.destroy().catch((err: unknown) => {
      console.warn('[vfs.load-view] failed to destroy pdf loading task', p, err);
    }));
  const onAbort = () => void destroy();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const doc = await loadingTask.promise;
    return { type: 'pdf', doc, size };
  } catch (err) {
    await destroy();
    if ((err as { name?: string })?.name === 'PasswordException') throw new Error(t('errors.pdfEncrypted'));
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** 尺寸探测最多等这么久；超时就不显示尺寸，不能让一张解码慢的大图把整个视图卡在 spinner。 */
const IMAGE_DIMENSIONS_TIMEOUT_MS = 2000;

/** 探测图片的固有像素尺寸（页头元信息用）。解码失败、超时、或没有固有尺寸（如无 width/height
 *  的 SVG 会报 0）时返回 undefined——尺寸只是锦上添花，不能挡住预览。浏览器会缓存解码结果，
 *  之后 `<img>` 再显示同一 blob URL 通常不会重复解码。 */
function readImageDimensions(url: string): Promise<ImageDimensions | undefined> {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(undefined), IMAGE_DIMENSIONS_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : undefined);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(undefined);
    };
    img.src = url;
  });
}

/** 行数：空文件 0 行，否则换行数 + 1。`\n`、`\r\n`、孤立的 `\r` 都算一次换行（与 `<pre>`
 *  的渲染一致）。用 indexOf 扫描而不是 split，避免为几十 MB 的文本物化一份行数组。 */
function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++;
  for (let i = text.indexOf('\r'); i !== -1; i = text.indexOf('\r', i + 1)) {
    if (text[i + 1] !== '\n') n++;
  }
  return n;
}

/** 释放视图持有的外部资源：blob URL、pdf.js 文档（含其 worker 侧内存）。幂等。
 *  由 App 在换视图前 / 过期加载 / 卸载时调用。 */
function releaseView(view: ViewState): void {
  if (view.kind !== 'file') return;
  if ('url' in view.media) URL.revokeObjectURL(view.media.url);
  // pdf.js 6 的销毁入口在 loadingTask 上：终止 worker 侧的文档并释放其内存。重复调用安全。
  if (view.media.type === 'pdf') {
    void view.media.doc.loadingTask.destroy().catch((err: unknown) => {
      console.warn('[vfs.load-view] failed to destroy pdf document', view.path, err);
    });
  }
}

/** 解析 `p` 为完整的 ViewState。任何失败都收敛为 `{ kind: 'error' }`，不抛出。
 *  会话标签与文件内容并行解析且永不 reject，所以 error 状态也能带上 session，
 *  面包屑在「文件不存在」时仍显示会话标题而不是「未知会话」。
 *  `signal` 由 App 在更新的导航到来时 abort：结果无论如何都会被丢弃，重活（PDF 解析）
 *  可以提前停下；已创建的资源仍由调用方对返回值调 `releaseView` 兜底。 */
async function loadView(p: string, signal: AbortSignal): Promise<ViewState> {
  const sessionPromise = loadSession(p);
  try {
    const st = await vfs.stat(p);
    if (st.isDirectory()) return await loadDir(p, await sessionPromise);
    const [media, session] = await Promise.all([loadFileMedia(p, st.size, signal), sessionPromise]);
    return { kind: 'file', path: p, media, session };
  } catch (err: any) {
    const message =
      err?.code === 'ENOENT'
        ? t('vfs.pathNotFound', [p])
        : err?.message ?? t('vfs.unknownError');
    return { kind: 'error', path: p, message, session: await sessionPromise };
  }
}

export { loadView, releaseView };

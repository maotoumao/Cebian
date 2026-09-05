import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadView, releaseView } from '@/entrypoints/vfs/lib/load-view';
import { vfs } from '@/lib/persistence/vfs';
import { loadPdfJs } from '@/lib/content/pdf-loader';
import type { ViewState } from '@/entrypoints/vfs/types';

// load-view 引用 `t`（错误文案），而 fakeBrowser 不实现 chrome.i18n.getMessage。
vi.mock('@/lib/i18n', () => ({ t: (key: string) => key }));
// 真实 vfs 依赖 IndexedDB，pdf.js 依赖 DOM / worker；这里只测 load-view 自己的编排与所有权。
vi.mock('@/lib/persistence/vfs', () => ({ vfs: { stat: vi.fn(), readFile: vi.fn(), readdir: vi.fn() } }));
vi.mock('@/lib/content/pdf-loader', () => ({ loadPdfJs: vi.fn() }));

/** 让 `vfs` 假实现返回一个文本文件，取加载结果里的行数。 */
async function linesOf(text: string): Promise<number> {
  vi.mocked(vfs.stat).mockResolvedValue({ isDirectory: () => false, size: text.length } as never);
  vi.mocked(vfs.readFile).mockResolvedValue(text as never);
  const view = await loadView('/home/user/.cebian/notes.txt', new AbortController().signal);
  if (view.kind !== 'file' || view.media.type !== 'text') throw new Error('expected text media');
  return view.media.lines;
}

describe('loadView · 行数统计', () => {
  it.each([
    ['', 0],
    ['a', 1],
    ['a\n', 2],
    ['a\nb', 2],
    ['\n', 2],
    ['a\r\nb\r\n', 3],
    ['a\rb\rc', 3],
    ['a\r\n\rb', 3],
  ])('%j → %i', async (text, expected) => {
    expect(await linesOf(text)).toBe(expected);
  });

  it('与 split(/\\r\\n|\\r|\\n/).length 的语义一致', async () => {
    for (const text of ['x\ny\n', 'x\r\ny', '\r', 'no newline', '\n\n\n']) {
      expect(await linesOf(text)).toBe(text.split(/\r\n|\r|\n/).length);
    }
  });
});

/** 构造一个最小的 pdf.js 假实现：`getDocument` 返回可控的 loadingTask。传 `pending` 时
 *  promise 悬而不决，由测试自己决定何时 reject（模拟解析进行中被 abort）。 */
function fakePdfJs(outcome: { doc?: { numPages: number }; error?: unknown; pending?: { reject: (e: unknown) => void } }) {
  const destroy = vi.fn(() => Promise.resolve());
  let promise: Promise<unknown>;
  if (outcome.pending) {
    const pending = outcome.pending;
    promise = new Promise((_, reject) => { pending.reject = reject; });
  } else {
    promise = outcome.error ? Promise.reject(outcome.error) : Promise.resolve({ ...outcome.doc, loadingTask: undefined as unknown });
  }
  const task = { destroy, promise };
  // 文档反向指回 loadingTask（pdf.js 6 的销毁入口就在它上面）。
  void task.promise.then((doc) => { (doc as { loadingTask: unknown }).loadingTask = task; }, () => {});
  const getDocument = vi.fn(() => task);
  vi.mocked(loadPdfJs).mockResolvedValue({ getDocument } as never);
  return { destroy, getDocument };
}

describe('loadView · pdf', () => {
  const PDF_PATH = '/home/user/.cebian/report.pdf';
  beforeEach(() => {
    vi.mocked(vfs.stat).mockResolvedValue({ isDirectory: () => false, size: 1234 } as never);
    vi.mocked(vfs.readFile).mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46]) as never);
  });

  it('解析成功：media 持有文档句柄，releaseView 经 loadingTask 销毁且可重复调用', async () => {
    const { destroy } = fakePdfJs({ doc: { numPages: 3 } });
    const view = await loadView(PDF_PATH, new AbortController().signal);
    expect(view.kind).toBe('file');
    if (view.kind !== 'file' || view.media.type !== 'pdf') throw new Error('expected pdf media');
    expect(view.media.doc.numPages).toBe(3);
    expect(view.media.size).toBe(1234);
    expect(destroy).not.toHaveBeenCalled();

    releaseView(view);
    releaseView(view);
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it('解析失败：loadingTask 被销毁（worker 不泄漏），密码保护给专门文案', async () => {
    const { destroy } = fakePdfJs({ error: Object.assign(new Error('No password given'), { name: 'PasswordException' }) });
    const view = await loadView(PDF_PATH, new AbortController().signal);
    expect(view).toMatchObject({ kind: 'error', path: PDF_PATH, message: 'errors.pdfEncrypted' });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('其他解析错误原样透出为 error 视图，同样销毁 loadingTask', async () => {
    const { destroy } = fakePdfJs({ error: new Error('Invalid PDF structure') });
    const view = await loadView(PDF_PATH, new AbortController().signal);
    expect(view).toMatchObject({ kind: 'error', message: 'Invalid PDF structure' });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('解析进行中被 abort：立即销毁 loadingTask，且解析失败后不会二次销毁', async () => {
    const pending = { reject: (_e: unknown) => {} };
    const { destroy, getDocument } = fakePdfJs({ pending });
    const controller = new AbortController();
    const pendingView = loadView(PDF_PATH, controller.signal);
    // 等 getDocument 被调用（abort 监听此时已挂上）。
    await vi.waitFor(() => expect(getDocument).toHaveBeenCalled());
    controller.abort();
    expect(destroy).toHaveBeenCalledTimes(1);
    // pdf.js 在 destroy 后会让解析 promise 拒绝；这条失败路径复用同一个销毁 promise。
    pending.reject(new Error('Worker was destroyed'));
    const view = await pendingView;
    expect(view.kind).toBe('error');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('导航已作废（signal 已 abort）时不再启动解析', async () => {
    const { getDocument } = fakePdfJs({ doc: { numPages: 1 } });
    const controller = new AbortController();
    controller.abort();
    const view = await loadView(PDF_PATH, controller.signal);
    expect(view.kind).toBe('error');
    expect(getDocument).not.toHaveBeenCalled();
  });
});

describe('releaseView · 非 pdf', () => {
  it('对目录 / 加载态 / 错误态是空操作，对带 blob URL 的媒体调用 revokeObjectURL', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const noops: ViewState[] = [
      { kind: 'loading', path: '/' },
      { kind: 'dir', path: '/', entries: [] },
      { kind: 'error', path: '/x', message: 'nope' },
      { kind: 'file', path: '/a.txt', media: { type: 'text', content: '', lines: 0, size: 0 } },
    ];
    noops.forEach(releaseView);
    expect(revoke).not.toHaveBeenCalled();

    releaseView({ kind: 'file', path: '/a.png', media: { type: 'image', mime: 'image/png', size: 1, url: 'blob:x' } });
    expect(revoke).toHaveBeenCalledWith('blob:x');
    revoke.mockRestore();
  });
});

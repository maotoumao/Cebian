import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { SessionLabelRow } from '@/lib/persistence/db';

/** 位图 / SVG 的像素尺寸，加载时探测；探测失败（如无固有尺寸的 SVG）则缺省。 */
interface ImageDimensions {
  width: number;
  height: number;
}

interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
}

/** 文件渲染模式的判别联合。加载器按 `classifyFile` + 体积上限选 type，`FileView` 按
 *  type 分发。持有外部资源的变体（blob `url`、pdf.js `doc`）由 `lib/load-view.ts` 创建、
 *  由 App 调 `releaseView` 释放（换视图前 / 过期加载 / 卸载时）——只有 App 知道一次加载
 *  是否已被更新的导航作废。文本变体携带加载时算好的 `lines`，避免 Toolbar 与正文各扫一遍内容。 */
type FileMedia =
  | { type: 'text'; content: string; lines: number; size: number }
  | { type: 'markdown'; content: string; lines: number; size: number }
  /** `lang` 是 highlight.js 语言 id（见 `CODE_LANG`）。 */
  | { type: 'code'; lang: string; content: string; lines: number; size: number }
  /** 预览态在沙箱页里渲染，源码态按 xml 高亮。 */
  | { type: 'html'; content: string; lines: number; size: number }
  /** 既是图片又是源码：预览态用 blob URL 走 `<img>`（脚本天然不执行），源码态按 xml 高亮。 */
  | { type: 'svg'; content: string; lines: number; size: number; url: string; dimensions?: ImageDimensions }
  | { type: 'image'; mime: string; size: number; url: string; dimensions?: ImageDimensions }
  | { type: 'video'; mime: string; size: number; url: string }
  | { type: 'audio'; mime: string; size: number; url: string }
  /** pdf.js 文档句柄：由 `lib/load-view.ts` 打开、由 App 通过 `releaseView` 销毁（与 blob URL 同一套所有权）。 */
  | { type: 'pdf'; doc: PDFDocumentProxy; size: number }
  | { type: 'binary'; size: number }
  | { type: 'tooLarge'; size: number };

/** 同时拥有「渲染态」和「源码态」两种视图的文件类型。预览 / 源码切换是这类文件的
 *  共有属性，切换状态按类型各自记忆（内存态，不持久化）。 */
type DualViewType = Extract<FileMedia['type'], 'markdown' | 'html' | 'svg'>;
type ViewMode = 'preview' | 'source';

/** 视图状态。`loading` / `error` 也携带 `path` 与（可继承的）`session`，这样面包屑在
 *  同一会话内导航时不会闪成「未知会话」。 */
type ViewState =
  | { kind: 'loading'; path: string; session?: SessionLabelRow }
  | {
      kind: 'dir';
      path: string;
      entries: DirEntry[];
      /** 仅当 `path` 正好是 `/workspaces` 时存在：`uuid → 会话标签行`，DirView 据此把
       *  UUID 子目录渲染成「会话标题 · 日期」并按最后活动倒序排。查不到的 UUID 不在 map 里。 */
      workspaceLabels?: Map<string, SessionLabelRow>;
      /** 当 `path` 位于某个会话工作区之下（任意深度）且会话仍存在时存在：该会话的标签行。
       *  面包屑据此把 UUID 段翻译成会话标题；DirView 在工作区目录本身据此渲染顶部信息条。 */
      session?: SessionLabelRow;
    }
  | { kind: 'file'; path: string; media: FileMedia; session?: SessionLabelRow }
  | { kind: 'error'; path: string; message: string; session?: SessionLabelRow };

export type { DirEntry, DualViewType, FileMedia, ImageDimensions, ViewMode, ViewState };

import { Suspense, lazy } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { t } from '@/lib/i18n';
import { formatBytes } from '@/lib/utils';
import type { FileMedia, ViewMode } from '../types';
import { CodeView } from './views/CodeView';
import { HtmlPreview } from './views/HtmlPreview';

import { MediaView } from './views/MediaView';
import { PdfView } from './views/PdfView';
import { Placeholder } from './views/Placeholder';
import { TextView } from './views/TextView';

// Markdown 渲染器（react-markdown + KaTeX 等，约 350 kB）只有打开 .md 时才需要，按需加载，
// 别让代码 / HTML / PDF 文件的首屏为它买单。
const MarkdownView = lazy(() => import('./views/MarkdownView').then((m) => ({ default: m.MarkdownView })));

/** 文件正文的分发器：按 media 类型选视图。没有外框、没有自己的头——文件名在面包屑，
 *  元信息与操作在页头 Toolbar，正文直接落在主区域（主区域是唯一滚动容器）。 */
function FileView({ path, media, mode }: { path: string; media: FileMedia; mode: ViewMode }) {
  const name = path.split('/').pop() ?? path;

  switch (media.type) {
    case 'text':
      return <TextView content={media.content} />;
    case 'markdown':
      return mode === 'preview'
        ? (
          <Suspense fallback={<div className="flex justify-center py-20"><Spinner className="size-5 text-primary" aria-label={t('common.loading')} /></div>}>
            <MarkdownView content={media.content} />
          </Suspense>
        )
        : <CodeView content={media.content} lines={media.lines} bytes={media.size} lang="markdown" />;
    case 'code':
      return <CodeView content={media.content} lines={media.lines} bytes={media.size} lang={media.lang} />;
    case 'html':
      return mode === 'preview'
        ? <HtmlPreview html={media.content} title={name} />
        : <CodeView content={media.content} lines={media.lines} bytes={media.size} lang="xml" />;
    case 'svg':
      return mode === 'preview'
        ? <MediaView media={media} name={name} />
        : <CodeView content={media.content} lines={media.lines} bytes={media.size} lang="xml" />;
    case 'image':
    case 'video':
    case 'audio':
      return <MediaView media={media} name={name} />;
    case 'pdf':
      return <PdfView doc={media.doc} />;
    case 'binary':
      return <Placeholder message={t('vfs.binaryFile', [formatBytes(media.size)])} />;
    case 'tooLarge':
      return <Placeholder message={t('vfs.tooLargeToPreview', [formatBytes(media.size)])} />;
    default: {
      // 穷尽性守卫：FileMedia 新增变体而这里没接住时由 TS 报错，而不是运行时渲染 undefined。
      const _exhaustive: never = media;
      return _exhaustive;
    }
  }
}

export { FileView };

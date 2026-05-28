import { useEffect } from 'react';
import { DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/lib/i18n';

interface IImagePreviewDialogOptions {
  src: string;
  alt?: string;
  /** 标记 `src` 是 dialog 自己应当负责清理的 blob URL（典型来自 VFS 内联图片
   *  点击预览路径）。dialog 卸载或 src 变化时自动 `URL.revokeObjectURL`，避免
   *  长会话里反复点开预览造成的累积内存占用。 */
  revokeSrcOnUnmount?: boolean;
}

export function ImagePreviewDialog({ src, alt, revokeSrcOnUnmount }: IImagePreviewDialogOptions) {
  useEffect(() => {
    if (!revokeSrcOnUnmount) return;
    return () => {
      try {
        URL.revokeObjectURL(src);
      } catch {
        // revoke 对非 blob URL 是 no-op，对已 revoke 的 URL 抛错 —— 全部当无关错误忽略。
      }
    };
  }, [src, revokeSrcOnUnmount]);

  return (
    <>
      <DialogHeader className="shrink-0 p-4 pb-3">
        <DialogTitle>{t('dialogs.imagePreview.title')}</DialogTitle>
      </DialogHeader>
      <div className="p-4 pt-0 overflow-auto flex-1 min-h-0">
        <img
          src={src}
          alt={alt || t('dialogs.imagePreview.alt')}
          className="max-w-full max-h-[85vh] object-contain mx-auto rounded"
        />
      </div>
    </>
  );
}

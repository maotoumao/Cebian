import { DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/lib/i18n';

interface IImagePreviewDialogOptions {
  src: string;
  alt?: string;
}

export function ImagePreviewDialog({ src, alt }: IImagePreviewDialogOptions) {
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

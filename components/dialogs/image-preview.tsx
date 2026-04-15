import { DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface IImagePreviewDialogOptions {
  src: string;
  alt?: string;
}

export function ImagePreviewDialog({ src, alt }: IImagePreviewDialogOptions) {
  return (
    <>
      <DialogHeader className="shrink-0 p-4 pb-3">
        <DialogTitle>图片预览</DialogTitle>
      </DialogHeader>
      <div className="p-4 pt-0 overflow-auto flex-1 min-h-0">
        <img
          src={src}
          alt={alt || '预览'}
          className="max-w-full max-h-[85vh] object-contain mx-auto rounded"
        />
      </div>
    </>
  );
}

import { File } from 'lucide-react';

/** 无法内联预览时的占位（二进制 / 超过体积上限）：居中一段说明，下载按钮在页头。 */
function Placeholder({ message }: { message: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
      <File size={40} strokeWidth={1} className="opacity-30" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

export { Placeholder };

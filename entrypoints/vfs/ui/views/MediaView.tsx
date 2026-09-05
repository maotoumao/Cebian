import type { FileMedia } from '../../types';

type Media = Extract<FileMedia, { type: 'image' | 'svg' | 'video' | 'audio' }>;

/** 图片（含 SVG 预览态）/ 视频 / 音频：填满主区域并居中，浅色底衬托透明区域，媒体适应
 *  视口不裁切。SVG 走 `<img>` 而不是内联，里面的脚本天然不会执行。 */
function MediaView({ media, name }: { media: Media; name: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6 bg-muted/40">
      {(media.type === 'image' || media.type === 'svg') && (
        <img src={media.url} alt={name} className="max-w-full max-h-full object-contain" />
      )}
      {media.type === 'video' && (
        <video src={media.url} controls className="max-w-full max-h-full" />
      )}
      {media.type === 'audio' && (
        <audio src={media.url} controls className="w-full max-w-md" />
      )}
    </div>
  );
}

export { MediaView };

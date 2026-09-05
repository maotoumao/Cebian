import { Code, Download, Eye, Link, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { CopyButton } from '@/components/common/CopyButton';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { copyText } from '@/lib/ui/clipboard';
import { t } from '@/lib/i18n';
import { languageName } from '../lib/highlight';
import { formatBytes } from '@/lib/utils';
import { supportsHtmlPreviewScripts } from '../lib/preview-capabilities';
import type { FileMedia, ViewMode, ViewState } from '../types';

interface ToolbarProps {
  view: ViewState;
  /** 当前文件为双视图类型时的视图模式（由 App 用 `dualViewTypeOf` 判定一次）；
   *  其他类型为 undefined，不显示切换控件。 */
  mode?: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  isDownloading: boolean;
  onDownload: () => void;
}

function ModeButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-[5px] text-xs transition-colors ' +
        (active ? 'bg-card text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground')
      }
    >
      {icon}
      {label}
    </button>
  );
}

/** 与旁边的 CopyButton 同一套 Button ghost/icon 样式，hover / focus 表现一致。 */
function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** HTML 预览态的沙箱标识：状态说明而不是操作，所以不是按钮；hover 出解释。 */
function SandboxBadge() {
  const label = supportsHtmlPreviewScripts ? t('vfs.sandboxPreview') : t('vfs.staticPreview');
  const hint = supportsHtmlPreviewScripts ? t('vfs.sandboxPreviewHint') : t('vfs.staticPreviewHint');
  const Icon = supportsHtmlPreviewScripts ? ShieldCheck : ShieldAlert;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex items-center gap-1 cursor-default">
          <Icon className="size-3.5" />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{hint}</TooltipContent>
    </Tooltip>
  );
}

/** 文件元信息的各段：源码给语言名、行数与大小；HTML 预览态给沙箱标识与大小；图片给
 *  像素尺寸与大小；PDF 给页数与大小；文本给行数与大小；其余给大小。 */
function fileMetaParts(media: FileMedia, mode: ViewMode | undefined): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  if (media.type === 'html' && mode === 'preview') {
    parts.push(<SandboxBadge key="sandbox" />);
  } else {
    if (media.type === 'code') parts.push(languageName(media.lang));
    if (media.type === 'pdf') parts.push(t('vfs.pageCount', media.doc.numPages));
    if ((media.type === 'image' || media.type === 'svg') && media.dimensions) {
      parts.push(`${media.dimensions.width} × ${media.dimensions.height}`);
    }
    if ('lines' in media && !(media.type === 'svg' && mode === 'preview')) parts.push(t('vfs.lines', [media.lines]));
  }
  parts.push(formatBytes(media.size));
  return parts;
}

/** 元信息按类型给最有用的一两项，各段之间用 `·` 分隔。 */
function describe(view: ViewState, mode: ViewMode | undefined): React.ReactNode | null {
  if (view.kind === 'dir') return t('vfs.itemCount', view.entries.length);
  if (view.kind !== 'file') return null;
  return fileMetaParts(view.media, mode).flatMap((part, i) =>
    i === 0 ? [part] : [<span key={`sep${i}`} className="opacity-50"> · </span>, part],
  );
}

/** 页头右侧：元信息 │ 预览/源码 · 复制路径 · 复制内容 · 下载。
 *  顺序按「被动信息在左、操作在右、越不可逆越靠右」排。
 *  加载中路径已知，所以「复制路径」保持挂载；元信息 / 切换 / 复制内容 / 下载要等内容
 *  到了才知道该不该显示。下载中即使 view 已切到 loading 也保持按钮挂载，否则用户会
 *  失去忙碌指示。复制内容始终复制源码（与模式无关），那才是用户要贴到别处的东西。 */
function Toolbar({ view, mode, onModeChange, isDownloading, onDownload }: ToolbarProps) {
  const meta = describe(view, mode);
  // error 态也保留「复制路径」：用户要把打不开的路径贴出去反馈时正需要它。
  const path = view.path;
  const loaded = view.kind === 'dir' || view.kind === 'file';
  const textContent = view.kind === 'file' && 'content' in view.media ? view.media.content : null;

  return (
    <div className="flex items-center gap-2 shrink-0">
      {meta && (
        <>
          <span className="inline-flex items-center text-xs text-muted-foreground tabular-nums whitespace-nowrap">{meta}</span>
          <div className="h-4 w-px bg-border" />
        </>
      )}

      {mode && (
        <div role="group" aria-label={t('vfs.viewMode')} className="inline-flex p-0.5 rounded-md border border-border bg-muted">
          <ModeButton active={mode === 'preview'} onClick={() => onModeChange('preview')} icon={<Eye className="size-3.5" />} label={t('vfs.preview')} />
          <ModeButton active={mode === 'source'} onClick={() => onModeChange('source')} icon={<Code className="size-3.5" />} label={t('vfs.source')} />
        </div>
      )}

      <IconButton
        label={t('vfs.copyPath')}
        onClick={async () => {
          if (await copyText(path, { silent: true })) toast.success(t('vfs.pathCopied'));
          else toast.error(t('common.copyFailed'));
        }}
      >
        <Link className="size-4" />
      </IconButton>

      {textContent !== null && <CopyButton text={textContent} />}

      {(loaded || isDownloading) && (
        <IconButton
          label={isDownloading ? t('vfs.zipping') : t('common.download')}
          onClick={onDownload}
          disabled={isDownloading}
        >
          {isDownloading ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
        </IconButton>
      )}
    </div>
  );
}

export { Toolbar };

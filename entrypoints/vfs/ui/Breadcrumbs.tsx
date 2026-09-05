import { ChevronRight, Ellipsis, Folder } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/lib/i18n';
import { fileExtension, navigateTo, pickFileIcon } from '../lib/path-utils';
import type { Crumb, CrumbSegment } from '../lib/breadcrumb';

const SEGMENT_BASE =
  'inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded-md whitespace-nowrap min-w-0 ' +
  '[&>span]:truncate [&>svg]:shrink-0';

function Segment({ segment, current }: { segment: CrumbSegment; current: boolean }) {
  // 根锚点自带图标；文件段用与目录列表相同的类型图标，让路径末尾和列表里的同一个文件长得一样。
  const Icon = segment.icon ?? (segment.kind === 'file' ? pickFileIcon(fileExtension(segment.label)) : undefined);
  const content = (
    <>
      {Icon && <Icon size={14} />}
      <span>{segment.label}</span>
    </>
  );

  // 当前段是页面标题：给最大的截断宽度、加粗、不可点。会话段作为当前段时保持可聚焦，
  // 键盘用户才能唤出 UUID tooltip。
  const el = current ? (
    <span
      aria-current="page"
      tabIndex={segment.kind === 'session' ? 0 : undefined}
      className={`${SEGMENT_BASE} max-w-[420px] text-foreground font-medium`}
    >
      {content}
    </span>
  ) : (
    <button
      type="button"
      onClick={() => navigateTo(segment.path)}
      className={`${SEGMENT_BASE} max-w-[180px] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors`}
    >
      {content}
    </button>
  );

  // 会话段：tooltip 同时给出完整标题与 UUID（真实目录名）；其余段只在截断时靠 title 兜底。
  if (segment.kind === 'session') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{el}</TooltipTrigger>
        <TooltipContent className="flex flex-col gap-0.5 items-start">
          <span>{segment.label}</span>
          <span className="font-mono opacity-70">{segment.tooltip}</span>
        </TooltipContent>
      </Tooltip>
    );
  }
  return <span title={segment.label} className="min-w-0 inline-flex">{el}</span>;
}

function CollapsedMenu({ hidden }: { hidden: CrumbSegment[] }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('vfs.showCollapsed')}
          title={t('vfs.showCollapsed')}
          className="inline-flex items-center px-1.5 py-0.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          <Ellipsis size={14} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuGroup>
          {hidden.map((seg) => (
            <DropdownMenuItem key={seg.path} onSelect={() => navigateTo(seg.path)}>
              <Folder className="text-muted-foreground" />
              <span className="truncate max-w-[280px]">{seg.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 语义面包屑的渲染层。段的内容由 `lib/breadcrumb.ts` 决定，这里只负责：
 *  正文字体（不用等宽）、截断宽度（当前段最大，父级段较小）、会话段的 UUID tooltip、
 *  「…」下拉展开被折叠的层级。最后一段是当前位置，不可点击。 */
function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label={t('vfs.location')} className="flex items-center gap-0.5 min-w-0 text-[13.5px]">
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        const key = crumb.kind === 'ellipsis' ? `…${i}` : crumb.path;
        return (
          <span key={key} className="flex items-center gap-0.5 min-w-0">
            {i > 0 && <ChevronRight size={14} className="shrink-0 text-muted-foreground/40" />}
            {crumb.kind === 'ellipsis' ? (
              <CollapsedMenu hidden={crumb.hidden} />
            ) : (
              <Segment segment={crumb} current={isLast} />
            )}
          </span>
        );
      })}
    </nav>
  );
}

export { Breadcrumbs };

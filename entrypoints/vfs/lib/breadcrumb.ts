/**
 * 语义面包屑——把机器路径翻译成「人读得懂的位置」。
 *
 * 面包屑只负责两件事：告诉用户在哪、让用户能往上走。它不需要是可复制的真实路径
 * （真实路径交给页头的「复制路径」）。所以：
 *   - 已知根目录折成一个带图标的锚点：`/workspaces` → 「工作区」，
 *     `/home/user/.cebian` → 「Cebian」；其余路径的根是裸 `/`。
 *   - `/workspaces/<uuid>` 段用会话标题替换，UUID 放进 tooltip。
 *   - 语义段超过 COLLAPSE_LIMIT 时，中间层级折叠成一个「…」下拉，始终保留
 *     前两段与后两段（根锚点、会话、父目录、当前）。
 *
 * 本文件是纯逻辑（无 DOM / React），渲染在 `ui/Breadcrumbs.tsx`。
 */
import { HardDrive, Home, MessageSquare, type LucideIcon } from 'lucide-react';
import type { SessionLabelRow } from '@/lib/persistence/db';
import { CEBIAN_HOME, WORKSPACES_ROOT } from '@/lib/persistence/vfs-paths';
import { t } from '@/lib/i18n';
import { sessionUuidOf } from './path-utils';
import { formatWorkspaceEntry } from './session-labels';

interface CrumbSegment {
  kind: 'root' | 'session' | 'dir' | 'file';
  /** 显示文本（根锚点 / 会话标题 / 目录名 / 文件名）。 */
  label: string;
  /** 点击跳转的真实 VFS 路径。 */
  path: string;
  icon?: LucideIcon;
  /** 仅会话段：完整 UUID（即真实目录名），hover 展示。 */
  tooltip?: string;
}

interface CrumbEllipsis {
  kind: 'ellipsis';
  /** 被折叠的中间层级，按从浅到深排列，每一项可跳转。 */
  hidden: CrumbSegment[];
}

type Crumb = CrumbSegment | CrumbEllipsis;

/** 语义段数超过此值时折叠中间层级。取 4 是因为「根 · 会话 · 父目录 · 当前」四段
 *  已经覆盖了工作区文件的常见深度，再深才需要折叠。 */
const COLLAPSE_LIMIT = 4;

interface RootAnchor {
  prefix: string;
  label: string;
  icon: LucideIcon;
}

function rootAnchors(): RootAnchor[] {
  return [
    { prefix: WORKSPACES_ROOT, label: t('vfs.roots.workspaces'), icon: MessageSquare },
    { prefix: CEBIAN_HOME, label: t('vfs.roots.cebian'), icon: Home },
  ];
}

function matchAnchor(path: string): RootAnchor | null {
  for (const anchor of rootAnchors()) {
    if (path === anchor.prefix || path.startsWith(anchor.prefix + '/')) return anchor;
  }
  return null;
}

/** 会话段的标签来源。`pending` = 会话标签还没查回来（加载态），只显示短 ID，不能说成
 *  「未知会话」——那是会话确实已删的意思。 */
type SessionLabel = SessionLabelRow | undefined | 'pending';

function sessionLabel(uuid: string, session: SessionLabel): string {
  if (session === 'pending') return uuid.slice(0, 8);
  return formatWorkspaceEntry(uuid, session).title;
}

/** 把 `path` 展开成完整的语义段列表（未折叠）。`isDir` 决定最后一段的 kind；
 *  加载中尚不知道类型时传 `undefined`，最后一段按目录处理（只影响图标）。 */
function expandSegments(
  path: string,
  isDir: boolean | undefined,
  session: SessionLabel,
): CrumbSegment[] {
  const anchor = matchAnchor(path);
  const root: CrumbSegment = anchor
    ? { kind: 'root', label: anchor.label, path: anchor.prefix, icon: anchor.icon }
    : { kind: 'root', label: '/', path: '/', icon: HardDrive };

  const rest = anchor ? path.slice(anchor.prefix.length) : path;
  const names = rest.split('/').filter(Boolean);
  // 与 load-view 同一判定：只有合法会话 ID 才是会话段，`/workspaces/readme.md` 之类不算。
  const sessionUuid = sessionUuidOf(path);
  const segments: CrumbSegment[] = [root];

  let acc = anchor ? anchor.prefix : '';
  names.forEach((name, i) => {
    acc += '/' + name;
    const isLast = i === names.length - 1;
    if (i === 0 && name === sessionUuid) {
      segments.push({
        kind: 'session',
        label: sessionLabel(name, session),
        path: acc,
        tooltip: name,
      });
      return;
    }
    segments.push({
      kind: isLast && isDir === false ? 'file' : 'dir',
      label: name,
      path: acc,
    });
  });
  return segments;
}

/** 语义段超过 COLLAPSE_LIMIT 时折叠：保留前两段与后两段，中间收进「…」。 */
function collapse(segments: CrumbSegment[]): Crumb[] {
  if (segments.length <= COLLAPSE_LIMIT) return segments;
  return [
    ...segments.slice(0, 2),
    { kind: 'ellipsis', hidden: segments.slice(2, -2) },
    ...segments.slice(-2),
  ];
}

/** 由当前路径构建面包屑。`session` 是该路径所属会话的标签行：会话已删（或不在工作区下）
 *  时为 undefined，会话段回落为「未知会话 · 短ID」；标签尚未查回时传 `'pending'`，只显示短 ID。 */
function buildCrumbs(
  path: string,
  isDir: boolean | undefined,
  session: SessionLabel,
): Crumb[] {
  return collapse(expandSegments(path, isDir, session));
}

export { buildCrumbs };
export type { Crumb, CrumbSegment };

import { describe, expect, it, vi } from 'vitest';
import { buildCrumbs, type Crumb, type CrumbSegment } from '@/entrypoints/vfs/lib/breadcrumb';

// 根锚点与会话回落文案走 `t`，而 fakeBrowser 不实现 chrome.i18n.getMessage。
// Mock 成「回显 key（+ 拼接占位参数）」——测的是段的结构，不耦合具体译文。
vi.mock('@/lib/i18n', () => ({
  t: (key: string, subs?: unknown[]) => (subs && subs.length ? `${key}|${subs.join(',')}` : key),
}));

const UUID = '3f2a9c1e-7b4d-4e8a-9f0c-1a2b3c4d5e6f';
const session = { id: UUID, title: '三季度经营分析', createdAt: 1, updatedAt: 2 };

function labels(crumbs: Crumb[]): string[] {
  return crumbs.map((c) => (c.kind === 'ellipsis' ? '…' : c.label));
}
function segment(crumb: Crumb): CrumbSegment {
  if (crumb.kind === 'ellipsis') throw new Error('expected a segment');
  return crumb;
}

describe('buildCrumbs · 根锚点折叠', () => {
  it('根目录只有一个 `/` 锚点', () => {
    const crumbs = buildCrumbs('/', true, undefined);
    expect(crumbs).toHaveLength(1);
    expect(segment(crumbs[0])).toMatchObject({ kind: 'root', label: '/', path: '/' });
  });

  it('`/workspaces` 折成工作区锚点，`/home/user/.cebian/...` 折成 Cebian 锚点', () => {
    const ws = buildCrumbs('/workspaces', true, undefined);
    expect(ws).toHaveLength(1);
    expect(segment(ws[0])).toMatchObject({ kind: 'root', label: 'vfs.roots.workspaces', path: '/workspaces' });

    const home = buildCrumbs('/home/user/.cebian/prompts/translate.md', false, undefined);
    expect(labels(home)).toEqual(['vfs.roots.cebian', 'prompts', 'translate.md']);
    expect(segment(home[0]).path).toBe('/home/user/.cebian');
    expect(segment(home[1]).path).toBe('/home/user/.cebian/prompts');
    expect(segment(home[2]).kind).toBe('file');
  });

  it('未知根路径按裸 `/` 逐段展开；前缀相似但不相等的路径不误匹配锚点', () => {
    const crumbs = buildCrumbs('/home/user', true, undefined);
    expect(labels(crumbs)).toEqual(['/', 'home', 'user']);
    expect(segment(crumbs[2])).toMatchObject({ kind: 'dir', path: '/home/user' });

    expect(labels(buildCrumbs('/workspacesfoo', true, undefined))).toEqual(['/', 'workspacesfoo']);
  });
});

describe('buildCrumbs · 会话段', () => {
  it('UUID 段替换为会话标题，UUID 进 tooltip，路径保留真实目录', () => {
    const crumbs = buildCrumbs(`/workspaces/${UUID}/report.md`, false, session);
    expect(segment(crumbs[1])).toMatchObject({
      kind: 'session',
      label: '三季度经营分析',
      tooltip: UUID,
      path: `/workspaces/${UUID}`,
    });
    expect(segment(crumbs[2])).toMatchObject({ kind: 'file', label: 'report.md' });
  });

  it('会话已删时回落为「未知会话 · 短ID」', () => {
    const crumbs = buildCrumbs(`/workspaces/${UUID}`, true, undefined);
    expect(segment(crumbs[1])).toMatchObject({
      kind: 'session',
      label: `vfs.unknownSession|${UUID.slice(0, 8)}`,
      tooltip: UUID,
    });
  });

  it('标签尚未查回（加载态）时只显示短 ID，不说「未知会话」', () => {
    const crumbs = buildCrumbs(`/workspaces/${UUID}/report.md`, undefined, 'pending');
    expect(segment(crumbs[1])).toMatchObject({ kind: 'session', label: UUID.slice(0, 8), tooltip: UUID });
  });

  it('`/workspaces/` 下第一段不是合法会话 ID 时按普通文件 / 目录处理', () => {
    const file = buildCrumbs('/workspaces/readme.md', false, undefined);
    expect(segment(file[1])).toMatchObject({ kind: 'file', label: 'readme.md' });
    expect(segment(file[1]).tooltip).toBeUndefined();

    const dir = buildCrumbs('/workspaces/scratch/notes', true, undefined);
    expect(segment(dir[1])).toMatchObject({ kind: 'dir', label: 'scratch' });
  });
});

describe('buildCrumbs · 折叠规则', () => {
  it('四段不折叠', () => {
    const crumbs = buildCrumbs(`/workspaces/${UUID}/reports/q3.html`, false, session);
    expect(labels(crumbs)).toEqual(['vfs.roots.workspaces', '三季度经营分析', 'reports', 'q3.html']);
  });

  it('恰好五段即折叠：中间只剩一项被收进「…」', () => {
    const crumbs = buildCrumbs(`/workspaces/${UUID}/data/raw/file.csv`, false, session);
    expect(labels(crumbs)).toEqual(['vfs.roots.workspaces', '三季度经营分析', '…', 'raw', 'file.csv']);
    const ellipsis = crumbs[2];
    if (ellipsis.kind !== 'ellipsis') throw new Error('expected ellipsis');
    expect(ellipsis.hidden.map((h) => h.label)).toEqual(['data']);
  });

  it('更深的路径把全部中间层级按顺序收进「…」，每项带可跳转路径', () => {
    const crumbs = buildCrumbs(`/workspaces/${UUID}/data/exports/2026/raw/file.csv`, false, session);
    expect(labels(crumbs)).toEqual(['vfs.roots.workspaces', '三季度经营分析', '…', 'raw', 'file.csv']);
    const ellipsis = crumbs[2];
    if (ellipsis.kind !== 'ellipsis') throw new Error('expected ellipsis');
    expect(ellipsis.hidden.map((h) => h.label)).toEqual(['data', 'exports', '2026']);
    expect(ellipsis.hidden[0].path).toBe(`/workspaces/${UUID}/data`);
    expect(ellipsis.hidden[2].path).toBe(`/workspaces/${UUID}/data/exports/2026`);
  });
});

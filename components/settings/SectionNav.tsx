import { Fragment } from 'react';
import { NavLink } from 'react-router-dom';
import { Key, MessageSquare, FileText, Blocks, Brain, Plug, Info, Database, MousePointerClick } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

interface SectionNavItem {
  path: string;
  /**
   * Resolves the label at render time so locale changes (and tree-shaking
   * of unused i18n keys) work correctly. Use a function instead of a key
   * string because `@wxt-dev/i18n`'s overloaded `t` collapses
   * `Parameters<typeof t>[0]` to `never`.
   */
  getLabel: () => string;
  icon: React.ComponentType<{ className?: string }>;
}

interface SectionNavGroup {
  /** 分组标题，只在宽屏竖排导航里显示；横排导航用分隔线代替。 */
  getLabel: () => string;
  items: SectionNavItem[];
}

/**
 * 设置页导航按用户意图分三组：
 * - 连接：把模型和外部工具接进来（AI 提供商、MCP）
 * - 定制：助手怎么想、怎么做（对话、提示词、技能、记忆、页面交互）
 * - 系统：我的数据在哪、这是什么版本（数据、关于）
 */
const SETTINGS_SECTION_GROUPS: SectionNavGroup[] = [
  {
    getLabel: () => t('settings.nav.group.connect'),
    items: [
      { path: 'providers', getLabel: () => t('settings.nav.providers'), icon: Key },
      { path: 'mcp', getLabel: () => t('settings.nav.mcp'), icon: Plug },
    ],
  },
  {
    getLabel: () => t('settings.nav.group.customize'),
    items: [
      { path: 'chat', getLabel: () => t('settings.nav.chat'), icon: MessageSquare },
      { path: 'prompts', getLabel: () => t('settings.nav.prompts'), icon: FileText },
      { path: 'skills', getLabel: () => t('settings.nav.skills'), icon: Blocks },
      { path: 'memory', getLabel: () => t('settings.nav.memory'), icon: Brain },
      { path: 'page-interaction', getLabel: () => t('settings.nav.pageInteraction'), icon: MousePointerClick },
    ],
  },
  {
    getLabel: () => t('settings.nav.group.system'),
    items: [
      { path: 'data', getLabel: () => t('settings.nav.data'), icon: Database },
      { path: 'about', getLabel: () => t('settings.nav.about'), icon: Info },
    ],
  },
];

/** 扁平的全部入口，供路由校验等不关心分组的调用方使用。 */
export const SETTINGS_SECTIONS: SectionNavItem[] = SETTINGS_SECTION_GROUPS.flatMap((g) => g.items);

/** Visual variant for SectionNav, mapped from SettingsLayout's breakpoint. */
type SectionNavVariant = 'pills' | 'tabs' | 'labels';

interface SectionNavProps {
  /** Absolute base path of the Settings hub (e.g. '/settings' in sidepanel, '' in tab page). */
  basePath: string;
  /**
   * Visual variant:
   * - `pills`  — 窄屏横排：只显示图标，当前项展开为图标 + 文字。
   * - `tabs`   — 中屏横排：图标 + 文字。
   * - `labels` — 宽屏竖排：带分组标题的侧栏（默认）。
   */
  variant?: SectionNavVariant;
}

const horizontalItem = 'flex items-center gap-1.5 h-8 rounded-md text-[13px] transition-colors whitespace-nowrap';
const activeColors = (isActive: boolean) =>
  isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground';

/** 横排导航里组与组之间的竖线。 */
function GroupSeparator() {
  return <li role="separator" className="w-px h-4 bg-border mx-1.5 shrink-0" />;
}

/**
 * SectionNav — navigation for Settings sections.
 *
 * Uses absolute paths derived from `basePath` so the same component works
 * under splat routes (`prompts/*`) without relative-path gotchas.
 */
export function SectionNav({ basePath, variant = 'labels' }: SectionNavProps) {
  if (variant === 'pills' || variant === 'tabs') {
    const pills = variant === 'pills';
    return (
      <nav
        aria-label={t('settings.nav.aria')}
        className="shrink-0 border-b border-border px-2 py-1.5 overflow-x-auto"
      >
        <ul className="flex items-center gap-0.5">
          {SETTINGS_SECTION_GROUPS.map((group, gi) => (
            <Fragment key={gi}>
              {gi > 0 && <GroupSeparator />}
              {group.items.map(({ path, getLabel, icon: Icon }) => {
                const label = getLabel();
                return (
                  <li key={path}>
                    <NavLink
                      to={`${basePath}/${path}`}
                      replace
                      title={pills ? label : undefined}
                      aria-label={pills ? label : undefined}
                      className={({ isActive }) =>
                        cn(
                          horizontalItem,
                          // pills 模式下非当前项只留图标（正方形），当前项展开成图标 + 文字，
                          // 让用户始终知道自己在哪，也顺带学会图标含义。
                          pills && !isActive ? 'size-8 justify-center' : 'px-2.5',
                          activeColors(isActive),
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <Icon className="size-4 shrink-0" />
                          {(!pills || isActive) && label}
                        </>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </Fragment>
          ))}
        </ul>
      </nav>
    );
  }

  // variant === 'labels'：每组一个带标题的 <ul>，读屏按组播报而不是把标题算作列表项。
  return (
    <nav aria-label={t('settings.nav.aria')} className="w-45 shrink-0 border-r border-border py-2 overflow-y-auto">
      {SETTINGS_SECTION_GROUPS.map((group, gi) => {
        const headingId = `settings-nav-group-${gi}`;
        return (
          <div key={gi} className={cn('px-2', gi > 0 && 'pt-4')}>
            <div id={headingId} className="px-3 pb-1 text-[11px] text-muted-foreground font-medium tracking-wide uppercase">
              {group.getLabel()}
            </div>
            <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
              {group.items.map(({ path, getLabel, icon: Icon }) => (
                <li key={path}>
                  <NavLink
                    to={`${basePath}/${path}`}
                    replace
                    className={({ isActive }) =>
                      cn('flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors', activeColors(isActive))
                    }
                  >
                    <Icon className="size-4" />
                    {getLabel()}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

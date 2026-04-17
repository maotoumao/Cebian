import { NavLink } from 'react-router-dom';
import { Key, MessageSquare, FileText, Blocks, Sliders, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SectionNavItem {
  path: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const SETTINGS_SECTIONS: SectionNavItem[] = [
  { path: 'providers', label: 'Providers', icon: Key },
  { path: 'instructions', label: '指引', icon: MessageSquare },
  { path: 'prompts', label: 'Prompts', icon: FileText },
  { path: 'skills', label: 'Skills', icon: Blocks },
  { path: 'advanced', label: '高级', icon: Sliders },
  { path: 'about', label: '关于', icon: Info },
];

interface SectionNavProps {
  /** Absolute base path of the Settings hub (e.g. '/settings' in sidepanel, '' in tab page). */
  basePath: string;
  /** Render as a horizontal icon-only pill row (used when container is narrow). */
  compact?: boolean;
}

/**
 * SectionNav — navigation for Settings sections.
 *
 * Two variants:
 * - Standard (default): vertical labeled sidebar on the left.
 * - Compact: horizontal icon-only pill row above the content (labels via `title`).
 *
 * Uses absolute paths derived from `basePath` so the same component works
 * under splat routes (`prompts/*`) without relative-path gotchas.
 */
export function SectionNav({ basePath, compact = false }: SectionNavProps) {
  if (compact) {
    return (
      <nav
        aria-label="设置导航"
        className="shrink-0 border-b border-border px-2 py-1.5 overflow-x-auto"
      >
        <ul className="flex items-center gap-0.5">
          {SETTINGS_SECTIONS.map(({ path, label, icon: Icon }) => (
            <li key={path}>
              <NavLink
                to={`${basePath}/${path}`}
                replace
                title={label}
                aria-label={label}
                className={({ isActive }) =>
                  cn(
                    'flex items-center justify-center size-8 rounded-md transition-colors',
                    isActive
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                  )
                }
              >
                <Icon className="size-4" />
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  return (
    <nav aria-label="设置导航" className="w-45 shrink-0 border-r border-border py-2 overflow-y-auto">
      <ul className="flex flex-col gap-0.5 px-2">
        {SETTINGS_SECTIONS.map(({ path, label, icon: Icon }) => (
          <li key={path}>
            <NavLink
              to={`${basePath}/${path}`}
              replace
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

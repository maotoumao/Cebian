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
}

/**
 * SectionNav — vertical sidebar navigation for Settings sections.
 *
 * Uses absolute paths derived from `basePath` to avoid the relative-path
 * pitfalls of nested routes and splat children (e.g. `prompts/:filename`).
 *
 * Stage 3 will add a responsive top-pills variant for narrower containers.
 */
export function SectionNav({ basePath }: SectionNavProps) {
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

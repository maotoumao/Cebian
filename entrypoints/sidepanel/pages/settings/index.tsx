import { useEffect, type ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useStorageItem } from '@/hooks/useStorageItem';
import { SettingsLayout } from '@/components/settings/SettingsLayout';
import { ProvidersSection } from '@/components/settings/sections/ProvidersSection';
import { InstructionsSection } from '@/components/settings/sections/InstructionsSection';
import { PromptsSection } from '@/components/settings/sections/PromptsSection';
import { SkillsSection } from '@/components/settings/sections/SkillsSection';
import { MCPSection } from '@/components/settings/sections/MCPSection';
import { AdvancedSection } from '@/components/settings/sections/AdvancedSection';
import { AboutSection } from '@/components/settings/sections/AboutSection';
import { lastSettingsSection } from '@/lib/storage';

interface SettingsRoutesProps {
  /** Absolute base path where SettingsRoutes is mounted (e.g. '/settings'). */
  basePath: string;
  /** Show back button in the top bar. True in sidepanel, false in standalone tab page. */
  showBackButton?: boolean;
  /** Show "open in new tab" button. True in sidepanel only. */
  showOpenInTab?: boolean;
}

/**
 * SettingsRoutes — top-level route tree for the Settings hub.
 *
 * Mounted at `/settings/*` in sidepanel (MemoryRouter) and at `/*` in the
 * standalone tab page (HashRouter). Only relative paths are used internally
 * so the same tree works under both routers. `basePath` is forwarded to
 * `SettingsLayout`/`SectionNav` so they can build absolute NavLinks.
 */
export function SettingsRoutes({ basePath, showBackButton = false, showOpenInTab = false }: SettingsRoutesProps) {
  return (
    <Routes>
      <Route element={<SettingsLayout basePath={basePath} showBackButton={showBackButton} showOpenInTab={showOpenInTab} />}>
        <Route index element={<SettingsIndexRedirect />} />
        <Route path="providers" element={<ProvidersSection />} />
        <Route path="instructions" element={<InstructionsSection />} />
        <Route path="prompts/*" element={<PromptsSection />} />
        <Route path="skills/*" element={<SkillsSection />} />
        <Route path="mcp" element={<MCPSection />} />
        <Route path="advanced" element={<AdvancedSection />} />
        <Route path="about" element={<AboutSection />} />
        <Route path="*" element={<Navigate to="." replace />} />
      </Route>
    </Routes>
  );
}

/** Redirects /settings to the last-visited section (fallback handled by storage item). */
function SettingsIndexRedirect(): ReactNode {
  const [target] = useStorageItem(lastSettingsSection, 'providers');
  return <Navigate to={target} replace />;
}

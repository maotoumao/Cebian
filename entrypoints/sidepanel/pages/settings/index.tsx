import { useEffect, type ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useStorageItem } from '@/hooks/useStorageItem';
import { SettingsLayout } from '@/components/settings/SettingsLayout';
import { SETTINGS_SECTIONS } from '@/components/settings/SectionNav';
import { ProvidersSection } from '@/components/settings/sections/ProvidersSection';
import { InstructionsSection } from '@/components/settings/sections/InstructionsSection';
import { PromptsSection } from '@/components/settings/sections/PromptsSection';
import { SkillsSection } from '@/components/settings/sections/SkillsSection';
import { MemorySection } from '@/components/settings/sections/MemorySection';
import { MCPSection } from '@/components/settings/sections/MCPSection';
import { BackupSection } from '@/components/settings/sections/BackupSection';
import { StorageSection } from '@/components/settings/sections/StorageSection';
import { AdvancedSection } from '@/components/settings/sections/AdvancedSection';
import { AboutSection } from '@/components/settings/sections/AboutSection';
import { lastSettingsSection } from '@/lib/persistence/storage';

interface SettingsRoutesProps {
  /** Absolute base path where SettingsRoutes is mounted (e.g. '/settings'). */
  basePath: string;
  /** Show back button in the top bar. True in sidepanel, false in standalone tab page. */
  showBackButton?: boolean;
  /** Show "open in new tab" button. True in sidepanel only. */
  showOpenInTab?: boolean;
  /** 返回按钮的回调；侧边栏传入「回到进设置前的聊天路由」。缺省时退回 /chat/new。 */
  onBack?: () => void;
}

/**
 * SettingsRoutes — top-level route tree for the Settings hub.
 *
 * Mounted at `/settings/*` in sidepanel (MemoryRouter) and at `/*` in the
 * standalone tab page (HashRouter). Only relative paths are used internally
 * so the same tree works under both routers. `basePath` is forwarded to
 * `SettingsLayout`/`SectionNav` so they can build absolute NavLinks.
 */
export function SettingsRoutes({ basePath, showBackButton = false, showOpenInTab = false, onBack }: SettingsRoutesProps) {
  return (
    <Routes>
      <Route element={<SettingsLayout basePath={basePath} showBackButton={showBackButton} showOpenInTab={showOpenInTab} onBack={onBack} />}>
        <Route index element={<SettingsIndexRedirect />} />
        <Route path="providers" element={<ProvidersSection />} />
        <Route path="instructions" element={<InstructionsSection />} />
        <Route path="prompts/*" element={<PromptsSection />} />
        <Route path="skills/*" element={<SkillsSection />} />
        <Route path="memory/*" element={<MemorySection />} />
        <Route path="mcp" element={<MCPSection />} />
        <Route path="backup" element={<BackupSection />} />
        <Route path="storage" element={<StorageSection />} />
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
  // 校验存储值仍指向一个有效 section：旧版本可能存了已停用的入口（如 'advanced'），
  // 直接重定向过去会命中 wildcard 路由回弹索引，造成循环。无效时回落到 providers。
  const valid = SETTINGS_SECTIONS.some((s) => s.path === target);
  return <Navigate to={valid ? target : 'providers'} replace />;
}

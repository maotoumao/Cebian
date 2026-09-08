import { useEffect, useState, type ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { SettingsLayout } from '@/components/settings/SettingsLayout';
import { SETTINGS_SECTIONS } from '@/components/settings/SectionNav';
import { ProvidersSection } from '@/components/settings/sections/ProvidersSection';
import { ChatSection } from '@/components/settings/sections/ChatSection';
import { PromptsSection } from '@/components/settings/sections/PromptsSection';
import { SkillsSection } from '@/components/settings/sections/SkillsSection';
import { MemorySection } from '@/components/settings/sections/MemorySection';
import { MCPSection } from '@/components/settings/sections/MCPSection';
import { PageInteractionSection } from '@/components/settings/sections/PageInteractionSection';
import { DataSection } from '@/components/settings/sections/DataSection';
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
 * 已合并 / 改名的旧 section 路径 → 现在的路径。
 *
 * 旧路径仍会从三处流进来：用户收藏或文档里的 `settings.html#/backup` 深链、
 * `lastSettingsSection` 里持久化的旧值、以及外部文章的截图指引。这里统一兜住，
 * 让它们落到合并后的新节而不是被 wildcard 弹回默认页。
 */
const LEGACY_SECTION_REDIRECTS: Record<string, string> = {
  instructions: 'chat',
  advanced: 'chat',
  backup: 'data',
  storage: 'data',
};

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
        <Route path="mcp" element={<MCPSection />} />
        <Route path="chat/*" element={<ChatSection />} />
        <Route path="prompts/*" element={<PromptsSection />} />
        <Route path="skills/*" element={<SkillsSection />} />
        <Route path="memory/*" element={<MemorySection />} />
        <Route path="page-interaction/*" element={<PageInteractionSection />} />
        <Route path="data" element={<DataSection />} />
        <Route path="about" element={<AboutSection />} />
        {Object.entries(LEGACY_SECTION_REDIRECTS).map(([from, to]) => (
          <Route key={from} path={from} element={<Navigate to={`../${to}`} replace />} />
        ))}
        <Route path="*" element={<Navigate to="." replace />} />
      </Route>
    </Routes>
  );
}

/**
 * /settings 索引页：跳到上次停留的 section。
 *
 * 必须等 `lastSettingsSection` 真正读出来再渲染 `<Navigate>`：`useStorageItem` 首帧返回
 * fallback，而 `<Navigate>` 挂载即跳转，用 hook 会永远落在默认页，存储值形同虚设。
 */
function SettingsIndexRedirect(): ReactNode {
  const [stored, setStored] = useState<string | null>(null);
  useEffect(() => {
    // 读取失败（如扩展重载后旧页面 context 失效）也要有去处：回落默认页而不是一直留白。
    lastSettingsSection.getValue().then(setStored, () => setStored('providers'));
  }, []);
  if (stored === null) return null;

  // 存储值可能是已合并的旧 section（先映射到新路径），也可能指向已彻底停用的入口。
  // 后者会落到 wildcard 路由、页面留白，因此校验后回落到 providers。
  const target = LEGACY_SECTION_REDIRECTS[stored] ?? stored;
  const valid = SETTINGS_SECTIONS.some((s) => s.path === target);
  return <Navigate to={valid ? target : 'providers'} replace />;
}

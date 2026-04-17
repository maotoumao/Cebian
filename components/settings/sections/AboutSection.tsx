/**
 * AboutSection — version + project links.
 * Migrated from the old SettingsPanel "关于" block (stage 2b).
 */
export function AboutSection() {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">关于</h2>

      <div className="space-y-1">
        <p className="text-sm font-medium">Cebian v0.1.0</p>
        <p className="text-xs text-muted-foreground">AI 浏览器侧边栏助手</p>
        <div className="flex gap-2 pt-2 text-xs text-muted-foreground">
          {/* Placeholders — final URLs TBD. Render as disabled-looking spans to avoid a11y lies. */}
          <span aria-disabled="true" className="cursor-not-allowed">GitHub</span>
          <span>·</span>
          <span aria-disabled="true" className="cursor-not-allowed">MIT License</span>
          <span>·</span>
          <span aria-disabled="true" className="cursor-not-allowed">反馈</span>
        </div>
      </div>
    </div>
  );
}

/**
 * AboutSection — version + project links.
 * Migrated from the old SettingsPanel "settings.about.title" block (stage 2b).
 */
import { t } from '@/lib/i18n';

export function AboutSection() {
  const version = chrome.runtime.getManifest().version;
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.about.title')}</h2>

      <div className="space-y-1">
        <p className="text-sm font-medium">Cebian v{version}</p>
        <p className="text-xs text-muted-foreground">{t('settings.about.tagline')}</p>
        <div className="flex gap-2 pt-2 text-xs text-muted-foreground">
          <a
            href="https://github.com/maotoumao/Cebian"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-foreground transition-colors"
          >
            GitHub
          </a>
          <span>·</span>
          <a
            href="https://github.com/maotoumao/Cebian/blob/HEAD/LICENSE"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-foreground transition-colors"
          >
            AGPL-3.0
          </a>
          <span>·</span>
          <a
            href="https://github.com/maotoumao/Cebian/issues"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-foreground transition-colors"
          >
            {t('settings.about.feedback')}
          </a>
        </div>
      </div>
    </div>
  );
}

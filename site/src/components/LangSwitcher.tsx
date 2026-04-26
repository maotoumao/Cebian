import type { Lang } from '../i18n';
import { languages, localePath } from '../i18n';

interface Props {
  lang: Lang;
  path: string;
}

export default function LangSwitcher({ lang, path }: Props) {
  const currentHref = localePath(lang, path);
  const languageOptions: Lang[] = ['zh', 'en'];

  return (
    <div className="relative inline-flex h-8 items-center">
      <select
        value={currentHref}
        onChange={(event) => {
          window.location.href = event.currentTarget.value;
        }}
        onMouseOver={(e) => { e.currentTarget.style.color = 'var(--fg)'; }}
        onMouseOut={(e) => { e.currentTarget.style.color = 'var(--fg-muted)'; }}
        aria-label="Switch language"
        title="Switch language"
        className="h-8 cursor-pointer appearance-none rounded-md py-0 pl-2.5 pr-7 text-[13px] outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{
          color: 'var(--fg-muted)',
          background: 'transparent',
          border: '1px solid var(--border)',
          outlineColor: 'var(--accent)',
        }}
      >
        {languageOptions.map((optionLang) => (
          <option
            key={optionLang}
            value={localePath(optionLang, path)}
            style={{ background: 'var(--bg)', color: 'var(--fg)' }}
          >
            {languages[optionLang].name}
          </option>
        ))}
      </select>
      <svg
        aria-hidden
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2"
        style={{ color: 'currentColor', opacity: 0.7 }}
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </div>
  );
}

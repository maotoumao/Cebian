/**
 * AboutSection — version, update check, project links, and social media.
 */
import type { ReactElement, ReactNode, SVGProps } from 'react';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { useUpdateCheck, getInstallGuideUrl } from '@/hooks/useUpdateCheck';

type SocialKey = 'wechat' | 'bilibili' | 'xiaohongshu' | 'x';

interface SocialLink {
  key: SocialKey;
  /** Omitted for entries that should render as plain text (e.g. WeChat OA). */
  href?: string;
  /** Brand accent color (hex). Used as a CSS variable on the card. */
  color: string;
  Icon: (props: SVGProps<SVGSVGElement>) => ReactElement;
}

const SOCIAL_LINKS: SocialLink[] = [
  {
    key: 'wechat',
    href: browser.runtime.getURL('/sponsor/wechat_channel.jpg' as never),
    color: '#07C160',
    Icon: WeChatIcon,
  },
  {
    key: 'bilibili',
    href: 'https://space.bilibili.com/12866223',
    color: '#00AEEC',
    Icon: BilibiliIcon,
  },
  {
    key: 'xiaohongshu',
    href: 'https://www.xiaohongshu.com/user/profile/5ce6085200000000050213a6',
    color: '#FF2442',
    Icon: XiaohongshuIcon,
  },
  {
    key: 'x',
    href: 'https://x.com/maotoumao0_0',
    color: 'currentColor',
    Icon: XIcon,
  },
];

const INSTALL_GUIDE_URL = getInstallGuideUrl();

export function AboutSection() {
  const { status, current, recheck } = useUpdateCheck();

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.about.title')}</h2>

      <div className="space-y-1">
        <p className="text-sm font-medium">Cebian v{current}</p>
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

      <UpdateCheckRow status={status} onRecheck={recheck} />

      <FollowAuthorSection />
    </div>
  );
}

function FollowAuthorSection() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <p className="text-sm font-medium">{t('settings.about.followAuthor')}</p>
        <div className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {SOCIAL_LINKS.map((link) => (
          <SocialCard key={link.key} link={link} />
        ))}
      </div>
    </div>
  );
}

function SocialCard({ link }: { link: SocialLink }) {
  const { Icon, color, key, href } = link;
  const label = t(`settings.about.socials.${key}` as `settings.about.socials.${SocialKey}`);
  const subtitle = t(
    `settings.about.socials.${key}Handle` as `settings.about.socials.${SocialKey}Handle`,
  );

  const cardClass = `
    group relative flex items-center gap-3 rounded-lg border border-border bg-card/50 px-4 py-3
    transition-all duration-200
  `;
  const hoverClass = `
    hover:-translate-y-0.5 hover:border-[var(--social-color)] hover:shadow-sm
    hover:bg-[color-mix(in_oklab,var(--social-color)_6%,transparent)]
  `;
  const style = { ['--social-color' as string]: color } as React.CSSProperties;

  const content = (
    <>
      <span
        className="
          flex h-10 w-10 shrink-0 items-center justify-center rounded-md
          bg-[color-mix(in_oklab,var(--social-color)_12%,transparent)]
          text-(--social-color)
          transition-transform duration-200 group-hover:scale-105
        "
        aria-hidden="true"
      >
        <Icon width={20} height={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{label}</span>
        <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
      </span>
    </>
  );

  if (!href) {
    return (
      <div className={cardClass} style={style}>
        {content}
      </div>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      style={style}
      className={`${cardClass} ${hoverClass}`}
    >
      {content}
    </a>
  );
}

interface UpdateCheckRowProps {
  status: ReturnType<typeof useUpdateCheck>['status'];
  onRecheck: () => void;
}

function UpdateCheckRow({ status, onRecheck }: UpdateCheckRowProps) {
  const isBusy = status.kind === 'checking';

  let statusNode: ReactNode = null;
  if (status.kind === 'checking') {
    statusNode = <span className="text-xs text-muted-foreground">{t('settings.about.checking')}</span>;
  } else if (status.kind === 'upToDate') {
    statusNode = <span className="text-xs text-muted-foreground">{t('settings.about.upToDate')}</span>;
  } else if (status.kind === 'error') {
    statusNode = <span className="text-xs text-destructive">{t('settings.about.checkFailed')}</span>;
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={onRecheck} disabled={isBusy} aria-busy={isBusy}>
          {t('settings.about.checkUpdate')}
        </Button>
        <span role="status" aria-live="polite">
          {statusNode}
        </span>
      </div>
      {status.kind === 'updateAvailable' && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-border bg-accent/40 p-3 space-y-2"
        >
          <p className="text-xs">{t('settings.about.updateAvailable', [status.latest])}</p>
          <Button asChild size="sm">
            <a href={INSTALL_GUIDE_URL} target="_blank" rel="noreferrer noopener">
              {t('settings.about.viewInstallGuide')}
            </a>
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Brand icons (inline SVG, simple-icons paths under CC0) ───

function WeChatIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.327.327 0 0 0 .166-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .55-.012.822-.036-.245-.74-.376-1.523-.376-2.328 0-4.142 4.025-7.5 8.989-7.5.273 0 .54.014.804.038-.737-3.379-4.245-5.946-8.435-5.946zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-3.96 0-7.108 2.733-7.108 6.087 0 3.353 3.147 6.086 7.108 6.086a8.41 8.41 0 0 0 2.355-.34.792.792 0 0 1 .65.078l1.59.91a.27.27 0 0 0 .14.04c.13 0 .24-.11.24-.247 0-.060-.02-.119-.039-.18l-.327-1.220a.5.5 0 0 1 .182-.557C23.314 18.43 24 16.85 24 15.119c0-3.354-3.348-6.261-7.062-6.261zm-2.396 2.222c.531 0 .963.443.963.989 0 .547-.432.99-.963.99-.531 0-.962-.443-.962-.99 0-.546.431-.989.962-.989zm4.844 0c.531 0 .962.443.962.989 0 .547-.431.99-.962.99-.531 0-.963-.443-.963-.99 0-.546.432-.989.963-.989z" />
    </svg>
  );
}

function BilibiliIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906l-1.174 1.12zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773H5.333zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.387-.947.258-.257.574-.386.946-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.387-.947.258-.257.574-.386.946-.386z" />
    </svg>
  );
}

function XiaohongshuIcon(props: SVGProps<SVGSVGElement>) {
  // Custom monogram — simple-icons doesn't ship a Xiaohongshu mark.
  return (
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" {...props}>
      <rect x="2" y="2" width="20" height="20" rx="5" fill="currentColor" />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="14"
        fontWeight="700"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fill="#fff"
      >
        {'\u7ea2'}
      </text>
    </svg>
  );
}

function XIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
    </svg>
  );
}

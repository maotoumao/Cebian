# Cebian Site

Marketing + docs site for [Cebian](https://github.com/maotoumao/Cebian), deployed at **https://cebian.catcat.work**.

## Tech stack

- [Astro 6](https://astro.build) — static site generator
- [Tailwind CSS v4](https://tailwindcss.com) — styling
- React 19 islands — only where interactivity is needed (theme toggle, language switcher)
- Deployed to **GitHub Pages** via the repository's [deployment workflow](../.github/workflows/deploy-site.yml)

## Local dev

```bash
cd site
pnpm install --ignore-workspace
pnpm dev
```

Visit http://localhost:4321. Default locale is `/zh/`; the English version lives under `/en/`.

## Build

```bash
pnpm build
pnpm preview
```

Output is in `dist/`.

## Deployment (GitHub Pages)

The site builds to a plain static `dist/` folder and is deployed by the repository's [GitHub Pages workflow](../.github/workflows/deploy-site.yml). Keep that workflow as the single source of truth for the deployment configuration.

Then in the repo's **Settings → Pages**, set the source to **GitHub Actions**. The `public/CNAME` file in this folder already points the custom domain `cebian.catcat.work` at the site, and `public/.nojekyll` disables Jekyll processing.

## Structure

```
src/
  layouts/      BaseLayout (head, fonts, theme bootstrap)
  components/   Nav, Footer, ScreenshotFrame, FeatureCard, LangSwitcher, ThemeToggle, ...
  i18n/         zh.ts / en.ts / shared types + helpers
  pages/
    index.astro          → /zh (redirect)
    404.astro
    [lang]/              → /zh/* and /en/* statically generated
      index.astro
      features.astro
      settings.astro
      install.astro
      sponsor.astro
      about.astro
      privacy.astro
      docs/
        index.astro
        getting-started.astro
        prompts.astro
        skills.astro
        mcp.astro
```

## Content editing

All user-facing text lives in `src/i18n/zh.ts` and `src/i18n/en.ts`. Both export an object matching the `Dict` type in `src/i18n/types.ts`. Add a field in the type, then add the same key in both locales — TypeScript will fail the build if a key goes missing.

## Screenshots

All product screenshots are currently placeholders rendered by `ScreenshotFrame.astro`. To replace one:

1. Drop the PNG into `public/screenshots/`.
2. Pass `src="/screenshots/foo.png"` to the `<ScreenshotFrame>` usage.

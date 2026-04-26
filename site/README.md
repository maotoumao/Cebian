# Cebian Site

Marketing + docs site for [Cebian](https://github.com/maotoumao/Cebian), deployed at **https://cebian.catcat.work**.

## Tech stack

- [Astro 5](https://astro.build) — static site generator
- [Tailwind CSS v4](https://tailwindcss.com) — styling
- React 19 islands — only where interactivity is needed (theme toggle, language switcher)
- Deployed to **GitHub Pages** via the workflow in `.github/workflows/site.yml`

## Local dev

```bash
cd site
pnpm install
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

The site builds to a plain static `dist/` folder. To deploy via GitHub Pages with the custom domain `cebian.catcat.work`, add the workflow below to **`.github/workflows/site.yml`** at the repo root (this folder only ships the site code — CI config lives outside `site/` and is intentionally not committed here):

```yaml
name: Deploy Site

on:
  push:
    branches: [main]
    paths:
      - 'site/**'
      - '.github/workflows/site.yml'
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: site
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
          cache-dependency-path: site/pnpm-lock.yaml
      - run: pnpm install --frozen-lockfile=false
      - run: pnpm build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: site/dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

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

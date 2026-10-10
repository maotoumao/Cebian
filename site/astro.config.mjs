// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { LOCALE_CODES, DEFAULT_LOCALE } from './locales.config.mjs';
import { fileURLToPath } from 'node:url';
import { createLastmod } from './scripts/sitemap-lastmod.mjs';

const lastmod = createLastmod(fileURLToPath(new URL('.', import.meta.url)));

// 三语静态站，部署到 GitHub Pages（纯静态，无服务端跳转）。
// 语言列表来自 locales.config.mjs（与 src/lib/i18n 共享单一来源）。
export default defineConfig({
  site: 'https://cebian.catcat.work',
  trailingSlash: 'always',
  i18n: {
    defaultLocale: DEFAULT_LOCALE,
    locales: LOCALE_CODES,
    routing: {
      prefixDefaultLocale: true,
      redirectToDefaultLocale: false,
    },
  },
  integrations: [
    mdx(),
    // 根 / 只是按浏览器语言跳转的 noindex 壳页，排除出 sitemap，避免冲突信号。
    sitemap({
      filter: (page) => new URL(page).pathname !== '/',
      serialize: (item) => {
        const date = lastmod(item.url);
        return date ? { ...item, lastmod: date } : item;
      },
    }),
  ],
});

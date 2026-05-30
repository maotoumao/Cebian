// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://cebian.catcat.work',
  trailingSlash: 'ignore',
  i18n: {
    defaultLocale: 'zh',
    locales: ['zh', 'en'],
    routing: {
      prefixDefaultLocale: true,
      redirectToDefaultLocale: false,
    },
  },
  integrations: [
    react(),
    // 根 / 只是按浏览器语言跳转的 noindex 壳页，排除出 sitemap，避免冲突信号。
    sitemap({ filter: (page) => new URL(page).pathname !== '/' }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});

import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react', '@wxt-dev/i18n/module'],
  manifest: {
    default_locale: 'en',
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    permissions: [
      'sidePanel', 'activeTab', 'tabs', 'scripting', 'storage', 'alarms',
      'offscreen', 'debugger', 'webNavigation',
      'bookmarks', 'history', 'cookies', 'topSites', 'sessions',
      'downloads', 'notifications',
      'clipboardRead',
    ],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: '__MSG_actionTitle__',
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
    server: {
      // Sandbox pages have origin: null — allow CORS from any origin in dev mode
      cors: true,
    },
    resolve: {
      alias: {
        // Replace isomorphic-textencoder with a shim that uses native
        // TextEncoder/TextDecoder — the upstream package crashes in Chrome
        // service worker strict mode (fast-text-encoding scope detection bug).
        'isomorphic-textencoder': path.resolve(__dirname, 'lib/shims/isomorphic-textencoder.js'),
      },
    },
  }),
});

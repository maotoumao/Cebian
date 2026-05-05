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
    // Inline the one Node-only `process.env.X` reference that
    // `@mariozechner/pi-ai`'s OAuth modules read at module load time
    // (openai-codex, anthropic). Without this, importing the oauth subpath
    // in the browser/SW throws `ReferenceError: process is not defined` at
    // module evaluation, killing background and sidepanel boot.
    // Other `process.*` access in those modules is guarded by
    // `typeof process !== "undefined"` or only runs inside Node-only code
    // paths gated by `process.versions?.node`, and is safe to leave alone.
    //
    // The replaced value is never actually read at runtime — it sits inside
    // a Node-only branch that is always skipped in the browser/SW. Cebian's
    // own OAuth flows live in `lib/oauth.ts` and don't depend on it.
    //
    //   - PI_OAUTH_CALLBACK_HOST  : pi-ai openai-codex / anthropic — host
    //                               for the local Node http.createServer
    //                               that receives the OAuth callback in
    //                               CLI mode.
    define: {
      'process.env.PI_OAUTH_CALLBACK_HOST': JSON.stringify('127.0.0.1'),
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

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
    // Override the MV3 sandbox-page CSP. Chrome's default is restrictive
    // (`script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self'`),
    // which would be fine for our existing skill executor — but MCP App
    // sandbox pages embed third-party HTML in srcdoc iframes that need
    // to load external resources (draw.io pulls scripts from
    // viewer.diagrams.net, sets `<base href="https://app.diagrams.net/">`,
    // etc.).
    //
    // Key fact: srcdoc iframes inherit the parent's CSP, and a resource
    // load must be allowed by every applicable policy (intersection).
    // The inner iframe's own meta CSP (constructed by `mcp-app.sandbox/
    // main.ts` from the resource's declared `_meta.ui.csp` allowlist)
    // is ALREADY the strict per-app boundary — but it's useless if the
    // outer page's policy is narrower than the inner's. Loosening here
    // lets the inner meta CSP become the operative constraint.
    //
    // Security: this only affects *sandbox pages* themselves, which are
    // our own code (`mcp-app.sandbox/main.ts` is a postMessage shuttle
    // that never issues fetches; the existing `sandbox/main.ts` skill
    // executor was already running with `unsafe-eval` on purpose). The
    // resource-loading discipline now lives one layer in, at the inner
    // iframe's meta CSP, where `DOMAIN_RE` enforces a strict allowlist
    // against server-declared domains.
    //
    // For the skill executor specifically: this override is a strict-or-
    // neutral change vs the Chrome default. `'unsafe-eval'` is preserved
    // (skills depend on it); `connect-src` / `img-src` / etc. were
    // implicitly unrestricted in the default and are now bounded to
    // `https:`/`data:`/`blob:` — a tightening, not a loosening.
    content_security_policy: {
      sandbox:
        "sandbox allow-scripts allow-forms allow-popups allow-modals; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:; " +
        "style-src 'self' 'unsafe-inline' https: data:; " +
        "connect-src 'self' https: wss: data: blob:; " +
        "img-src 'self' data: blob: https:; " +
        "font-src 'self' data: https:; " +
        "media-src 'self' data: blob: https:; " +
        "child-src 'self' data: blob:; " +
        "base-uri *;",
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

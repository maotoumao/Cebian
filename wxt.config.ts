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
    // ⚠ Cross-entry effect: manifest's `content_security_policy.sandbox`
    // applies to ALL sandbox pages, not just `mcp-app.html`. Compared to
    // Chrome's default (`script-src 'self' 'unsafe-inline' 'unsafe-eval';
    // child-src 'self'`, with `default-src` implicitly `'none'` for the
    // rest), this override:
    //   - WIDENS `script-src` with `https: data: blob:` — a skill in the
    //     existing executor can now load remote scripts. Accepted because
    //     skills are user-installed code with an existing trust model
    //     (and `'unsafe-eval'` already let them execute arbitrary code).
    //   - WIDENS `connect-src` / `img-src` / `media-src` / etc. from the
    //     `default-src 'none'` baseline to allow `https:` / `data:` /
    //     `blob:`. Same trust rationale.
    //   - TIGHTENS nothing — there's no directive this override narrows.
    //
    // Splitting per-entry would require WXT-level support that doesn't
    // exist; accept the shared widening as a one-time trust trade-off.
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
    plugins: [
      // 把 pi-ai 内部 `./anthropic.js` 的相对导入重定向到本地 shim，
      // 让 Anthropic OAuth 模块（包含一段 base64 字面量 → atob 解码
      // 的 client ID，会被 Chrome Web Store 审核判定为代码混淆）从
      // bundle 中彻底剔除。Cebian 不使用 Anthropic OAuth，仅消费 pi-ai
      // 的 GitHub Copilot / OpenAI Codex 辅助函数；详见
      // `lib/shims/pi-ai-anthropic.js` 注释。
      //
      // `enforce: 'pre'` 让本插件在 Vite 内置解析器之前运行 —— 我们
      // 拦截的是 raw 相对 specifier (`./anthropic.js`)，必须抢在它被
      // 解析成绝对路径之前命中。`importer` 路径做正/反斜杠归一化，避免
      // Windows 路径分隔符影响匹配。
      {
        name: 'cebian:stub-pi-ai-anthropic',
        enforce: 'pre' as const,
        resolveId(id: string, importer: string | undefined) {
          if (id !== './anthropic.js' || !importer) return null;
          const normalized = importer.replace(/\\/g, '/');
          if (!normalized.includes('/@earendil-works/pi-ai/dist/utils/oauth/')) return null;
          return path.resolve(__dirname, 'lib/shims/pi-ai-anthropic.js');
        },
      },
      // pi-ai 的 GitHub Copilot OAuth 模块（`utils/oauth/github-copilot.js`）
      // 在源码里把 client ID 写成 `(s => atob(s))("SXYxLmI1MDdhMDhjODdlY2ZlOTg=")`。
      // 这条模式会被 Chrome Web Store 审核判定为 obfuscated code（违规
      // ID：Red Titanium），Cebian 此前提交被拒就是被这两行命中。
      //
      // 跟 Anthropic 模块不同的是：Cebian 真实在用 GitHub Copilot OAuth
      // (`lib/oauth.ts` → `loginGitHubCopilot` / `refreshGitHubCopilotToken`)，
      // 不能整段 stub 掉。所以这里走 `transform` 钩子，**只**在打包时
      // 把这两行改写成明文的等价赋值，模块的其它部分原样保留。
      //
      // 明文 client ID 不是 secret —— `Iv1.b507a08c87ecfe98` 是 GitHub
      // Copilot Chat 的公开 OAuth client ID（VS Code Copilot Chat、
      // `gh` CLI 都用同一个，网络抓包就能看到），把它当成普通常量
      // 字面量是合规的。
      //
      // 防御性 `throw`：如果 pi-ai 升级后改动了这两行的写法，匹配会
      // 失败 → build 立刻 fail-fast，提醒维护者重新核对 shim，而不是
      // 悄无声息把混淆代码塞回 bundle。
      {
        name: 'cebian:depobfuscate-pi-ai-copilot',
        enforce: 'pre' as const,
        transform(code: string, id: string) {
          // 路径归一化：反斜杠 → 斜杠 + 去掉 `?query` 后缀。后者是为了
          // 防止未来某次 Vite/WXT 升级给模块 id 加上 `?v=...` 之类的
          // 查询串导致 endsWith 失配 —— 那种情况下 transform 会变成
          // 静默 no-op，下面的 fail-loud throw 也不会触发，等于直接把
          // 混淆代码塞回 bundle。
          const normalized = id.replace(/\\/g, '/').split('?')[0];
          if (!normalized.endsWith('/@earendil-works/pi-ai/dist/utils/oauth/github-copilot.js')) {
            return null;
          }
          const OBFUSCATED =
            'const decode = (s) => atob(s);\n' +
            'const CLIENT_ID = decode("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");';
          const REPLACEMENT = 'const CLIENT_ID = "Iv1.b507a08c87ecfe98";';
          if (!code.includes(OBFUSCATED)) {
            throw new Error(
              '[cebian:depobfuscate-pi-ai-copilot] 未在 pi-ai github-copilot.js ' +
              '找到预期的 atob 模式，可能是 upstream 升级后改了实现。' +
              '请重新核对 wxt.config.ts 里的 transform 并更新匹配字符串。',
            );
          }
          // 返回 `{ code, map: null }` 而不是裸字符串，显式声明我们
          // 不维护新的 sourcemap（替换只删了一行，对 upstream 行号有
          // 轻微影响，但 OAuth 调试场景几乎用不到原始 map）。
          return { code: code.replace(OBFUSCATED, REPLACEMENT), map: null };
        },
      },
      tailwindcss(),
    ],
    server: {
      // Sandbox pages have origin: null — allow CORS from any origin in dev mode
      cors: true,
    },
    // Inline the one Node-only `process.env.X` reference that
    // `@earendil-works/pi-ai`'s OAuth modules read at module load time
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

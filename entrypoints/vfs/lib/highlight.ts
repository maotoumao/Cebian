/**
 * 源码高亮——VFS 页面里唯一直接接触 highlight.js 的地方。
 *
 * 语法表从 `lowlight` 的 `common`（约 40 种常见语言）取：聊天里 MarkdownRenderer 经
 * rehype-highlight → lowlight 已经把同一批 `highlight.js/lib/languages/*` ESM 模块打进了
 * 共享 chunk，这里复用它们而不是引 `highlight.js/lib/common`——后者是 CJS 再包一层，会把
 * 全部语法再打一份进 vfs chunk。核心走 `highlight.js/lib/core`，与 lowlight 用的是同一个
 * 模块实例。配色复用全局的 `assets/code-highlight.css`（`.hljs-*` 类）。
 *
 * 高亮是同步的，超过阈值的文件不高亮，避免几十万行卡死页面。
 */
import hljs from 'highlight.js/lib/core';
import { common } from 'lowlight';

for (const [name, grammar] of Object.entries(common)) hljs.registerLanguage(name, grammar);

/** 超过任一阈值就退回纯文本渲染（仍有行号与横向滚动）。字节数用文件的真实大小，
 *  而不是 UTF-16 的 `content.length`——中文为主的文件两者差三倍。 */
const HIGHLIGHT_MAX_LINES = 10_000;
const HIGHLIGHT_MAX_BYTES = 1024 * 1024;

/** hljs 自带的显示名有几处不适合放进页头（`HTML, XML`、`TOML, also INI`、小写 `php`）。 */
const DISPLAY_NAME_OVERRIDES: Record<string, string> = {
  xml: 'XML',
  ini: 'INI',
  php: 'PHP',
};

/** 高亮后的 HTML：用户文本已由 highlight.js 转义，剩余标签与 class 全部由它的 renderer
 *  生成，可直接 `dangerouslySetInnerHTML`。语言未注册、内容超阈值、或语法本身抛错时返回
 *  null，调用方渲染纯文本。 */
function highlightCode(
  content: string,
  lang: string,
  limits: { lines: number; bytes: number },
): string | null {
  if (limits.lines > HIGHLIGHT_MAX_LINES || limits.bytes > HIGHLIGHT_MAX_BYTES) return null;
  if (!hljs.getLanguage(lang)) return null;
  try {
    return hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
  } catch (err) {
    // 语法定义崩掉不该让整页白屏；退回纯文本正好是现成的降级路径。
    console.warn('[vfs.highlight] highlight failed, falling back to plain text', err);
    return null;
  }
}

/** 语言的人类可读名（`typescript` → `TypeScript`）；未注册的语言回落为 id 本身。 */
function languageName(lang: string): string {
  return DISPLAY_NAME_OVERRIDES[lang] ?? hljs.getLanguage(lang)?.name ?? lang;
}

export { HIGHLIGHT_MAX_LINES, HIGHLIGHT_MAX_BYTES, highlightCode, languageName };

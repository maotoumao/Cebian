// 「抽取契约」这个事物：用户脚本怎样被送进结果页执行、执行结果怎样被读回并校验。
//
// 用户写的是一段完整脚本（`function extract({ document, query }) { … }`），不是函数体：
// 自成合法 JS、可复制粘贴、编辑器高亮正确，也允许定义多个辅助函数（与划词动作的
// transform 脚本同一约定，见 entrypoints/offscreen/transform-sandbox.ts）。
//
// 执行路径有两条，本文件为两条都提供源码拼装，并用同一个 `interpretPagePayload` 读回：
//   1. `chrome.scripting.executeScript` 注入 `runExtractInPage`（MAIN / ISOLATED world）；
//   2. 站点 CSP 拦住 `new Function` 时，走 CDP `Runtime.evaluate`（executeViaDebugger），
//      此时用户源码直接内联进表达式，不再经过 `new Function`。

import { oneLine, truncate } from '@/lib/utils';
import type { ExtractResult, ExtractStatus, SearchResultItem } from './types';

/** 页内 runner 在 CSP 拦住 `new Function` 时返回的哨兵。 */
const EXTRACT_CSP_BLOCKED = '__cebian_extract_csp_blocked__';

/**
 * 识别「被 CSP 拦住」的报错措辞：Chrome（unsafe-eval / Content Security Policy）、
 * Firefox（blocked by CSP）、Trusted Types（TrustedScript）。
 * 与 `runExtractInPage` 内联的正则必须一致（有测试兜着）。
 */
const CSP_ERROR_RE = /unsafe-eval|Content Security Policy|blocked by CSP|TrustedScript/i;

/** 用户源码缺少 `extract` 函数时的报错文案；两条执行路径共用。 */
const MISSING_EXTRACT_MESSAGE = 'Script must define a function named "extract"';

/**
 * 拼在用户源码之后的调用尾：在**同一作用域**里查 `extract` 并调用，故用户的函数声明
 * 会遮蔽页面上可能存在的 `window.extract`；脚本没定义时标识符会沿作用域链落到页面全局，
 * 所以还要排除「解析到的就是全局那个」——否则站点自己的 `extract` 会被当成用户脚本调用。
 * `typeof … !== 'function'` 对未声明的标识符也安全。临时变量带 `__cebian_` 前缀，避免
 * 和用户的顶层声明撞名。
 */
const RUNNER_TAIL =
  `\n;if (typeof extract !== 'function' || extract === globalThis.extract) return ${JSON.stringify(`Error: ${MISSING_EXTRACT_MESSAGE}`)};` +
  `\nreturn extract(__cebian_args);`;

/**
 * 注入结果页的 runner。**必须自包含**：`chrome.scripting.executeScript` 用 `toString()`
 * 序列化它，外部常量在页内不存在，所以尾巴与正则都以字面量重复一份。
 *
 * 永不 throw：`chrome.scripting` 会吞掉页内的 rejection（结果变成 `undefined`），所以
 * 一切结局都编码成字符串返回——JSON 结果、`"Error: …"`、或 CSP 哨兵。在页内就地
 * `JSON.stringify` 还能把环 / BigInt / DOM 节点变成可捕获的错误，而不是被序列化层
 * 悄悄改写成 `undefined`。
 */
async function runExtractInPage(source: string, query: string, cspSentinel: string): Promise<string> {
  try {
    const tail =
      '\n;if (typeof extract !== \'function\' || extract === globalThis.extract) return "Error: Script must define a function named \\"extract\\"";' +
      '\nreturn extract(__cebian_args);';
    const fn = new Function('__cebian_args', source + tail);
    const out = await fn({ document, query });
    if (typeof out === 'string' && out.startsWith('Error: ')) return out;
    if (out === undefined) return 'Error: extract() returned undefined';
    // JSON.stringify 对函数 / Symbol 返回 undefined，不能让它漏成非字符串。
    const json = JSON.stringify(out);
    return json === undefined ? 'Error: extract() returned a value that is not JSON' : json;
  } catch (e: any) {
    let message: string;
    try {
      message = typeof e?.message === 'string' ? e.message : String(e);
    } catch {
      // `throw Object.create(null)` 之类连 String() 都会再抛。
      message = 'script threw a value that cannot be described';
    }
    if (/unsafe-eval|Content Security Policy|blocked by CSP|TrustedScript/i.test(message)) return cspSentinel;
    return `Error: ${message}`;
  }
}

/**
 * CDP 路径的代码：`executeViaDebugger` 会把它包成 `(async () => { … })()`，所以用户源码
 * 直接内联（不经 `new Function`，不受站点 CSP 约束），`query` 经 `JSON.stringify` 变成
 * 字面量，含引号 / 反引号 / 换行都不会越出字符串。
 */
function buildDebuggerExtractCode(source: string, query: string): string {
  return `const __cebian_args = { document, query: ${JSON.stringify(query)} };\n${source}${RUNNER_TAIL}`;
}

type PagePayload =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

/**
 * 读回两条执行路径的原始返回。`chrome.scripting` 路径返回 `runExtractInPage` 的字符串；
 * CDP 路径（executeViaDebugger）返回 `"Error: …"`、`"(no return value)"`，或值本身
 * （字符串原样、其它 JSON 化）。`undefined` = 页内抛了未捕获异常。
 */
function interpretPagePayload(raw: unknown): PagePayload {
  if (raw === undefined || raw === null) {
    return { ok: false, reason: 'script threw an uncaught exception in the page' };
  }
  if (typeof raw !== 'string') return { ok: true, value: raw };
  if (raw.startsWith('Error: ')) return { ok: false, reason: raw.slice('Error: '.length).trim() };
  if (raw === '(no return value)') return { ok: false, reason: 'extract() returned undefined' };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: 'extract() returned a value that is not JSON' };
  }
}

// ─── 结果归一化 ───

const SNIPPET_MAX = 300;
const TITLE_MAX = 200;
const STATUSES: readonly ExtractStatus[] = ['ok', 'empty', 'blocked'];

type NormalizedExtract =
  | { ok: true; result: ExtractResult }
  | { ok: false; reason: string };

function normalizeItem(raw: unknown, baseUrl: string): SearchResultItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== 'string' || typeof r.url !== 'string') return null;
  const title = truncate(oneLine(r.title), TITLE_MAX);
  if (!title) return null;
  let url: string;
  try {
    // 脚本拿 `getAttribute('href')` 会给出相对地址，按搜索页 URL 解析。
    const parsed = new URL(r.url, baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    url = parsed.href;
  } catch {
    return null;
  }
  const snippet = typeof r.snippet === 'string' ? truncate(oneLine(r.snippet), SNIPPET_MAX) : '';
  return snippet ? { title, url, snippet } : { title, url };
}

/**
 * 防御性校验脚本返回值：只信 plain JSON。形状不对整体判失败（该引擎记 failed 并附原因）；
 * 单条不合规（缺 title / url、非 http(s)）丢弃；按 url 去重；截到 `maxResults`。
 */
function normalizeExtractResult(value: unknown, opts: { maxResults: number; baseUrl: string }): NormalizedExtract {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'extract() must return an object like { status, results }' };
  }
  const v = value as Record<string, unknown>;
  if (!STATUSES.includes(v.status as ExtractStatus)) {
    return { ok: false, reason: `extract() returned an invalid status: ${JSON.stringify(v.status)}` };
  }
  const status = v.status as ExtractStatus;
  if (status !== 'ok') return { ok: true, result: { status, results: [] } };
  if (!Array.isArray(v.results)) {
    return { ok: false, reason: 'extract() returned status "ok" without a results array' };
  }
  const seen = new Set<string>();
  const results: SearchResultItem[] = [];
  for (const raw of v.results) {
    if (results.length >= opts.maxResults) break;
    const item = normalizeItem(raw, opts.baseUrl);
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);
    results.push(item);
  }
  return { ok: true, result: { status, results } };
}

// ─── 编辑器侧：脚本校验与模板 ───

/**
 * 脚本至少要**声明**一个 `extract`（`function extract` 或 `const/let/var extract =`）。
 * 不认裸赋值 `extract = …`：在 runner 的 sloppy `new Function` 里它会写成页面全局，
 * 恰好被尾巴的「解析到全局那个」防护拒掉——编辑器说合法、运行时说没定义，用户无从理解。
 * 不做完整解析，运行时另有兜底。
 */
function validateExtractScript(source: string): boolean {
  return /\bfunction\s+extract\s*\(|\b(?:const|let|var)\s+extract\s*=/.test(source);
}

/**
 * 「从选择器生成模板」：给一个结果容器选择器（和可选的条目选择器），产出一份能跑的
 * 起手脚本。用户接着改细节，比如解包跳转链接。
 */
function extractScriptFromSelector(containerSelector: string, itemSelector = 'li, .result, [data-result]'): string {
  // 注释行也是代码的一部分：选择器带换行会把第二行变成裸代码，先压成单行。
  return `function extract({ document, query }) {
  // Results container: ${oneLine(containerSelector)}
  const root = document.querySelector(${JSON.stringify(containerSelector)});
  if (!root) return { status: 'empty', results: [] };
  const results = [...root.querySelectorAll(${JSON.stringify(itemSelector)})]
    .map((el) => {
      const a = el.querySelector('a[href]');
      if (!a) return null;
      return {
        title: (a.textContent || '').trim(),
        url: a.href,
        snippet: (el.textContent || '').trim().slice(0, ${SNIPPET_MAX}),
      };
    })
    .filter((r) => r && r.title && /^https?:/.test(r.url));
  return { status: 'ok', results };
}`;
}

/** 新建自定义引擎时预填的脚本。 */
const EXTRACT_SCRIPT_TEMPLATE = extractScriptFromSelector('#results');

export {
  EXTRACT_CSP_BLOCKED,
  runExtractInPage,
  buildDebuggerExtractCode,
  interpretPagePayload,
  normalizeExtractResult,
  validateExtractScript,
  extractScriptFromSelector,
  EXTRACT_SCRIPT_TEMPLATE,
  type PagePayload,
};
// 仅为单测暴露：断言页内 runner 内联的字面量与这些常量保持一致。
export { CSP_ERROR_RE, MISSING_EXTRACT_MESSAGE, RUNNER_TAIL };

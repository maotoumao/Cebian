import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import {
  CSP_ERROR_RE,
  EXTRACT_CSP_BLOCKED,
  EXTRACT_SCRIPT_TEMPLATE,
  MISSING_EXTRACT_MESSAGE,
  RUNNER_TAIL,
  buildDebuggerExtractCode,
  extractScriptFromSelector,
  interpretPagePayload,
  normalizeExtractResult,
  runExtractInPage,
  validateExtractScript,
} from '@/lib/search/extract';

// runner 在页内以全局 `document` 为参数；vitest 跑在 Node 里，给一个只够脚本走通的最小替身。
beforeAll(() => {
  (globalThis as any).document = { querySelector: () => null, baseURI: 'https://x.test/' };
});
afterAll(() => {
  delete (globalThis as any).document;
});

const OK_SCRIPT = `function extract({ document, query }) {
  return { status: 'ok', results: [{ title: 'T ' + query, url: 'https://a.test/', snippet: 's' }] };
}`;

describe('runExtractInPage', () => {
  it('定义了 extract → 返回结果的 JSON；参数里带 query', async () => {
    const raw = await runExtractInPage(OK_SCRIPT, 'q1', EXTRACT_CSP_BLOCKED);
    expect(JSON.parse(raw)).toEqual({ status: 'ok', results: [{ title: 'T q1', url: 'https://a.test/', snippet: 's' }] });
  });

  it('async extract 会被 await', async () => {
    const raw = await runExtractInPage(
      `async function extract() { await null; return { status: 'empty', results: [] }; }`,
      'q',
      EXTRACT_CSP_BLOCKED,
    );
    expect(JSON.parse(raw)).toEqual({ status: 'empty', results: [] });
  });

  it('没定义 extract → 统一的 Error 哨兵（与导出的文案一致）', async () => {
    const raw = await runExtractInPage('const x = 1;', 'q', EXTRACT_CSP_BLOCKED);
    expect(raw).toBe(`Error: ${MISSING_EXTRACT_MESSAGE}`);
  });

  it('页面全局有同名 extract 时仍解析到脚本自己的声明', async () => {
    (globalThis as any).extract = () => ({ status: 'blocked', results: [] });
    try {
      const raw = await runExtractInPage(OK_SCRIPT, 'q', EXTRACT_CSP_BLOCKED);
      expect(JSON.parse(raw).status).toBe('ok');
      // 脚本没定义时也不该捡到全局的那个。
      expect(await runExtractInPage('', 'q', EXTRACT_CSP_BLOCKED)).toBe(`Error: ${MISSING_EXTRACT_MESSAGE}`);
    } finally {
      delete (globalThis as any).extract;
    }
  });

  it('脚本抛错 → Error: 前缀 + 消息；CSP 类报错 → CSP 哨兵', async () => {
    expect(await runExtractInPage(`function extract() { throw new Error('boom'); }`, 'q', EXTRACT_CSP_BLOCKED)).toBe('Error: boom');
    for (const msg of ['Refused to evaluate: unsafe-eval', 'call to Function() blocked by CSP', "requires 'TrustedScript' assignment"]) {
      const raw = await runExtractInPage(`function extract() { throw new Error(${JSON.stringify(msg)}); }`, 'q', EXTRACT_CSP_BLOCKED);
      expect(raw).toBe(EXTRACT_CSP_BLOCKED);
      expect(CSP_ERROR_RE.test(msg)).toBe(true);
    }
  });

  it('返回 undefined / 函数 / 循环引用 → Error 字符串而不是坏 JSON；抛出无法描述的值也不会漏成 rejection', async () => {
    expect(await runExtractInPage(`function extract() {}`, 'q', EXTRACT_CSP_BLOCKED)).toBe('Error: extract() returned undefined');
    expect(await runExtractInPage(`function extract() { return () => 1; }`, 'q', EXTRACT_CSP_BLOCKED)).toBe('Error: extract() returned a value that is not JSON');
    const raw = await runExtractInPage(`function extract() { const o = {}; o.self = o; return o; }`, 'q', EXTRACT_CSP_BLOCKED);
    expect(raw.startsWith('Error: ')).toBe(true);
    expect(await runExtractInPage(`function extract() { throw Object.create(null); }`, 'q', EXTRACT_CSP_BLOCKED)).toBe('Error: script threw a value that cannot be described');
  });

  it('内联的尾巴与 CSP 正则和导出常量保持一致（runner 必须自包含，不能引用它们）', () => {
    // 转译后的源码里引号被反斜杠转义，比较前先去掉反斜杠。
    const src = runExtractInPage.toString().replace(/\\/g, '');
    expect(src).toContain(MISSING_EXTRACT_MESSAGE);
    expect(src).toContain('__cebian_args');
    expect(src).toContain(CSP_ERROR_RE.source);
    expect(RUNNER_TAIL.replace(/\\/g, '')).toContain(MISSING_EXTRACT_MESSAGE);
  });
});

describe('buildDebuggerExtractCode', () => {
  it('query 含引号 / 反引号 / 换行时不越出字面量，包成 async IIFE 后能执行', async () => {
    const query = 'a"b`c\nd${e}';
    const code = buildDebuggerExtractCode(`function extract({ query }) { return { status: 'ok', results: [], q: query }; }`, query);
    const value = await new Function(`return (async () => { ${code} })()`)();
    expect(value.q).toBe(query);
    const missing = await new Function(`return (async () => { ${buildDebuggerExtractCode('', 'q')} })()`)();
    expect(missing).toBe(`Error: ${MISSING_EXTRACT_MESSAGE}`);
  });
});

describe('interpretPagePayload', () => {
  it('五种输入各归其位', () => {
    expect(interpretPagePayload(undefined)).toEqual({ ok: false, reason: 'script threw an uncaught exception in the page' });
    expect(interpretPagePayload('Error: nope')).toEqual({ ok: false, reason: 'nope' });
    expect(interpretPagePayload('(no return value)')).toEqual({ ok: false, reason: 'extract() returned undefined' });
    expect(interpretPagePayload('not json').ok).toBe(false);
    expect(interpretPagePayload('{"status":"ok","results":[]}')).toEqual({ ok: true, value: { status: 'ok', results: [] } });
    // 非字符串值（两条路径都不该出现）作为防御分支直接透传。
    expect(interpretPagePayload({ status: 'ok' })).toEqual({ ok: true, value: { status: 'ok' } });
  });
});

describe('normalizeExtractResult', () => {
  const opts = { maxResults: 10, baseUrl: 'https://www.bing.com/search?q=x' };

  it('非对象 / 坏 status / ok 却没有 results 数组 → 整体失败并说明原因', () => {
    expect(normalizeExtractResult('x', opts).ok).toBe(false);
    expect(normalizeExtractResult([], opts).ok).toBe(false);
    expect(normalizeExtractResult({ status: 'nope', results: [] }, opts)).toMatchObject({ ok: false, reason: expect.stringContaining('"nope"') });
    expect(normalizeExtractResult({ status: 'ok' }, opts)).toMatchObject({ ok: false, reason: expect.stringContaining('results array') });
  });

  it('empty / blocked 不要求 results', () => {
    expect(normalizeExtractResult({ status: 'blocked' }, opts)).toEqual({ ok: true, result: { status: 'blocked', results: [] } });
  });

  it('丢弃缺 title / url、非 http(s) 的条目；相对地址按搜索页解析；按 url 去重；snippet 单行截断', () => {
    const out = normalizeExtractResult(
      {
        status: 'ok',
        results: [
          { title: 'A', url: 'https://a.test/' },
          { title: '  ', url: 'https://blank.test/' },
          { title: 'no url' },
          { title: 'js', url: 'javascript:alert(1)' },
          { title: 'mail', url: 'mailto:x@y.z' },
          { title: 'rel', url: '/ck/a?u=1', snippet: '  multi\n  line   text  ' },
          { title: 'dup', url: 'https://a.test/' },
          { title: 'long', url: 'https://long.test/', snippet: 'x'.repeat(400) },
        ],
      },
      opts,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.results).toEqual([
      { title: 'A', url: 'https://a.test/' },
      { title: 'rel', url: 'https://www.bing.com/ck/a?u=1', snippet: 'multi line text' },
      { title: 'long', url: 'https://long.test/', snippet: `${'x'.repeat(300)}…` },
    ]);
  });

  it('title 也截断，maxResults 为 0 时不返回条目', () => {
    const out = normalizeExtractResult({ status: 'ok', results: [{ title: 'x'.repeat(500), url: 'https://a.test/' }] }, opts);
    expect(out.ok && out.result.results[0].title).toBe(`${'x'.repeat(200)}…`);
    const none = normalizeExtractResult({ status: 'ok', results: [{ title: 'a', url: 'https://a.test/' }] }, { ...opts, maxResults: 0 });
    expect(none.ok && none.result.results).toEqual([]);
  });

  it('截到 maxResults；ok + [] 原样保留', () => {
    const many = { status: 'ok', results: Array.from({ length: 5 }, (_, i) => ({ title: `t${i}`, url: `https://x.test/${i}` })) };
    const out = normalizeExtractResult(many, { ...opts, maxResults: 2 });
    expect(out.ok && out.result.results.map((r) => r.url)).toEqual(['https://x.test/0', 'https://x.test/1']);
    expect(normalizeExtractResult({ status: 'ok', results: [] }, opts)).toEqual({ ok: true, result: { status: 'ok', results: [] } });
  });
});

describe('validateExtractScript / extractScriptFromSelector', () => {
  it('认函数声明与赋值式，不认没有 extract 的脚本', () => {
    expect(validateExtractScript('function extract() {}')).toBe(true);
    expect(validateExtractScript('const extract = async ({ document }) => 1')).toBe(true);
    expect(validateExtractScript('let extract = function () {}')).toBe(true);
    expect(validateExtractScript('function extractAll() {}')).toBe(false);
    // 裸赋值在 runner 里会变成页面全局并被拒，编辑器同样不认。
    expect(validateExtractScript('extract = function () {}')).toBe(false);
  });

  it('生成的模板是完整的 extract 函数，选择器经 JSON 转义', async () => {
    const script = extractScriptFromSelector(`#results\n> li[data-x="1"]`);
    expect(validateExtractScript(script)).toBe(true);
    expect(script).toContain('"#results\\n> li[data-x=\\"1\\"]"');
    // 带换行的选择器不能把注释行的第二半变成裸代码。
    expect(script).toContain('// Results container: #results > li[data-x="1"]');
    expect(EXTRACT_SCRIPT_TEMPLATE).toContain('"#results"');
    // 能通过 runner 跑起来（document 上没有该容器 → empty）。
    const raw = await runExtractInPage(script, 'q', EXTRACT_CSP_BLOCKED);
    expect(JSON.parse(raw)).toEqual({ status: 'empty', results: [] });
  });
});

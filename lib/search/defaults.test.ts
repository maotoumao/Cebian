import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { getBuiltinSearchEngine } from '@/lib/search/defaults';
import { EXTRACT_CSP_BLOCKED, runExtractInPage, validateExtractScript } from '@/lib/search/extract';
import { BUILTIN_SEARCH_ENGINE_IDS } from '@/lib/search/types';

vi.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
}));

// 内置脚本写在模板字面量里，反斜杠会被字面量吃掉一层，光靠 tsc 看不出脚本自身的语法错误。
// 这里用真正的 runner 在一个「什么都查不到」的最小 document 上把每份脚本跑一遍。
beforeAll(() => {
  (globalThis as any).document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    baseURI: 'https://example.test/',
    location: { hostname: 'www.example.test', pathname: '/search' },
  };
});
afterAll(() => {
  delete (globalThis as any).document;
});

describe('内置引擎默认脚本', () => {
  it.each(BUILTIN_SEARCH_ENGINE_IDS)('%s：能解析、定义了 extract、在空页面上返回 empty', async (id) => {
    const def = getBuiltinSearchEngine(id)!;
    expect(validateExtractScript(def.extract)).toBe(true);
    const raw = await runExtractInPage(def.extract, 'q', EXTRACT_CSP_BLOCKED);
    expect(raw.startsWith('Error: ')).toBe(false);
    expect(JSON.parse(raw)).toEqual({ status: 'empty', results: [] });
  });

  it('Google / 百度在拦截页特征上返回 blocked', async () => {
    (globalThis as any).document.location = { hostname: 'www.google.com', pathname: '/sorry/index' };
    expect(JSON.parse(await runExtractInPage(getBuiltinSearchEngine('google')!.extract, 'q', EXTRACT_CSP_BLOCKED)).status).toBe('blocked');
    (globalThis as any).document.location = { hostname: 'wappass.baidu.com', pathname: '/' };
    expect(JSON.parse(await runExtractInPage(getBuiltinSearchEngine('baidu')!.extract, 'q', EXTRACT_CSP_BLOCKED)).status).toBe('blocked');
  });
});

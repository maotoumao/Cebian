// 内置搜索引擎的默认定义：地址模板 + 抽取脚本 + 适用场景。
//
// 领域内容随概念走（AGENTS.md），不进 constants 大杂烩。脚本字符串里的注释只用英文：
// `scripts/lint-i18n.mjs` 会扫 lib/ 下非注释行的中文，模板字面量里的注释在它眼里不是注释。
// 脚本写在模板字面量里，反斜杠会被字面量先吃掉一层（`\/` → `/`），正则里的斜杠用
// `[/]` 表示；defaults.test.ts 会把每份脚本真正编译一遍兜底。
//
// 三态契约在每个脚本里的体现：结果容器不存在 → `empty`（可能还在渲染，工具会短暂重试）；
// 明确识别到验证码 / 拦截特征 → `blocked`（不重试）；容器在但没抽到条目 → `ok` + `[]`。
// 用户在设置里改过的字段以覆盖层形式存储，这里的默认值永远可以「恢复」。

import { t } from '@/lib/i18n';
import type { BuiltinSearchEngineId } from './types';

interface BuiltinSearchEngineDef {
  id: BuiltinSearchEngineId;
  /** 随界面语言解析（百度在中文界面显示「百度」）。 */
  getName: () => string;
  urlTemplate: string;
  extract: string;
  /** 缺省的适用场景提示；大多数引擎没有。 */
  getWhen?: () => string;
}

const BING: BuiltinSearchEngineDef = {
  id: 'bing',
  getName: () => t('settings.chat.search.engines.bing.name'),
  urlTemplate: 'https://www.bing.com/search?q={query}',
  extract: `function extract({ document }) {
  const root = document.querySelector('#b_results');
  if (!root) return { status: 'empty', results: [] };
  if (root.querySelector('.b_no')) return { status: 'ok', results: [] };

  // Bing wraps result hrefs as bing.com/ck/a?...&u=a1<base64url of the real URL>.
  const unwrap = (href) => {
    try {
      const u = new URL(href);
      if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/')) {
        const enc = u.searchParams.get('u');
        if (enc && enc.startsWith('a1')) {
          const decoded = atob(enc.slice(2).replace(/-/g, '+').replace(/_/g, '/'));
          // Only trust the decoded text when it actually is an absolute URL.
          if (/^https?:[/][/]/i.test(decoded)) return decoded;
        }
      }
    } catch {}
    return href;
  };

  const results = [...root.querySelectorAll('li.b_algo')].map((li) => {
    const a = li.querySelector('h2 a');
    if (!a) return null;
    return {
      title: a.textContent.trim(),
      url: unwrap(a.href),
      snippet: li.querySelector('.b_caption p, .b_lineclamp2, .b_algoSlug')?.textContent?.trim() ?? '',
    };
  }).filter(Boolean);
  return { status: 'ok', results };
}`,
};

const BRAVE: BuiltinSearchEngineDef = {
  id: 'brave',
  getName: () => t('settings.chat.search.engines.brave.name'),
  urlTemplate: 'https://search.brave.com/search?q={query}',
  extract: `function extract({ document }) {
  const root = document.querySelector('#results');
  if (!root) return { status: 'empty', results: [] };

  const results = [...root.querySelectorAll('.snippet[data-type="web"]')].map((el) => {
    const a = el.querySelector('a[href^="http"]');
    if (!a) return null;
    return {
      title: (el.querySelector('.title') || a).textContent.trim(),
      url: a.href,
      snippet: el.querySelector('.snippet-description, .snippet-content')?.textContent?.trim() ?? '',
    };
  }).filter(Boolean);
  return { status: 'ok', results };
}`,
};

const GOOGLE: BuiltinSearchEngineDef = {
  id: 'google',
  getName: () => t('settings.chat.search.engines.google.name'),
  urlTemplate: 'https://www.google.com/search?q={query}',
  extract: `function extract({ document }) {
  // "Unusual traffic" interstitial (/sorry/, captcha form) or the consent page:
  // both need a human, so retrying is pointless.
  if (
    document.location.hostname === 'consent.google.com' ||
    document.location.pathname.startsWith('/sorry/') ||
    document.querySelector('#captcha-form, form[action*="/sorry/"]')
  ) {
    return { status: 'blocked', results: [] };
  }
  const root = document.querySelector('#rso, #search');
  if (!root) return { status: 'empty', results: [] };

  const results = [...root.querySelectorAll('a[href^="http"] h3')].map((h3) => {
    const a = h3.closest('a');
    const block = h3.closest('div[data-hveid], div.g') || a.parentElement;
    return {
      title: h3.textContent.trim(),
      url: a.href,
      snippet: block?.querySelector('div[data-sncf], div[style*="-webkit-line-clamp"], .VwiC3b')?.textContent?.trim() ?? '',
    };
  });
  return { status: 'ok', results };
}`,
};

const DUCKDUCKGO: BuiltinSearchEngineDef = {
  id: 'duckduckgo',
  getName: () => t('settings.chat.search.engines.duckduckgo.name'),
  urlTemplate: 'https://html.duckduckgo.com/html/?q={query}',
  extract: `function extract({ document }) {
  if (document.querySelector('.anomaly-modal__title, form[action*="/challenge"]')) {
    return { status: 'blocked', results: [] };
  }
  const root = document.querySelector('.results, #links');
  if (!root) return { status: 'empty', results: [] };
  if (root.querySelector('.no-results')) return { status: 'ok', results: [] };

  const results = [...root.querySelectorAll('.result')].map((el) => {
    const a = el.querySelector('a.result__a');
    if (!a) return null;
    // Result links are wrapped as duckduckgo.com/l/?uddg=<encoded real URL>.
    // searchParams.get() already decodes once; decoding again would corrupt
    // targets that contain %26 / %23 themselves.
    let url = a.href;
    try {
      const real = new URL(a.href, document.baseURI).searchParams.get('uddg');
      if (real) url = real;
    } catch {}
    return {
      title: a.textContent.trim(),
      url,
      snippet: el.querySelector('.result__snippet')?.textContent?.trim() ?? '',
    };
  }).filter(Boolean);
  return { status: 'ok', results };
}`,
};

const BAIDU: BuiltinSearchEngineDef = {
  id: 'baidu',
  getName: () => t('settings.chat.search.engines.baidu.name'),
  getWhen: () => t('settings.chat.search.engines.baidu.when'),
  urlTemplate: 'https://www.baidu.com/s?wd={query}',
  extract: `function extract({ document }) {
  // Verification interstitial lives on wappass.baidu.com.
  if (document.location.hostname.startsWith('wappass.')) return { status: 'blocked', results: [] };
  const root = document.querySelector('#content_left');
  if (!root) return { status: 'empty', results: [] };

  const results = [...root.querySelectorAll('.result, .result-op')].map((el) => {
    const a = el.querySelector('h3 a');
    if (!a) return null;
    return {
      title: a.textContent.trim(),
      // href is a baidu.com/link redirect; the real address is in the mu attribute.
      url: el.getAttribute('mu') || a.href,
      snippet: el.querySelector('[class*="content-right"], .c-abstract, .c-span-last')?.textContent?.trim() ?? '',
    };
  }).filter(Boolean);
  return { status: 'ok', results };
}`,
};

const REGISTRY = {
  bing: BING,
  brave: BRAVE,
  google: GOOGLE,
  duckduckgo: DUCKDUCKGO,
  baidu: BAIDU,
} satisfies Record<BuiltinSearchEngineId, BuiltinSearchEngineDef>;

/** 按 id 取内置引擎定义；`Object.hasOwn` 拒绝原型键。 */
function getBuiltinSearchEngine(id: string): BuiltinSearchEngineDef | undefined {
  return Object.hasOwn(REGISTRY, id) ? REGISTRY[id as BuiltinSearchEngineId] : undefined;
}

export { getBuiltinSearchEngine };

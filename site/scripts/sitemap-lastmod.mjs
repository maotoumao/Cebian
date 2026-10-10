import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { LOCALE_CODES } from '../locales.config.mjs';

/** 将真实页面映射回内容文件，不用模板或构建时钟统一刷新全站日期。 */
function contentPaths(site, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  const lang = parts.shift();
  if (!LOCALE_CODES.includes(lang)) return [];
  const source = join(site, 'src');
  const locale = join(source, 'lib/i18n/locales', lang === 'en' ? 'en.ts' : 'zh.ts');
  if (parts[0] === 'docs') {
    if (parts.length === 1) return [join(source, 'content/docs', lang)];
    const file = join(source, 'content/docs', lang, ...parts.slice(1), 'index.mdx');
    if (!existsSync(file)) return [];
    // 同目录图片以及显式引入的共享媒体也是该文档内容的一部分。
    const assets = [...readFileSync(file, 'utf8').matchAll(/from\s+['"]@\/assets\/([^'"]+)['"]/g)]
      .map((match) => resolve(source, 'assets', match[1]));
    return [dirname(file), ...assets];
  }
  if (parts.length === 0) return [join(source, 'pages/[lang]/index.astro'), join(source, 'components/home'), locale];
  if (parts.length !== 1) return [];
  if (parts[0] === 'changelog') return [join(site, '..', 'CHANGELOG.md')];
  if (['about', 'sponsor'].includes(parts[0])) return [join(source, `pages/[lang]/${parts[0]}.astro`), locale];
  return [];
}

/** 缺失完整历史时省略日期，不能把浅克隆边界误报为内容更新时间。 */
function createLastmod(site) {
  let root;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: site, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, encoding: 'utf8' }).trim();
    if (shallow === 'true') return () => undefined;
  } catch { return () => undefined; }
  const cache = new Map();
  return (url) => {
    const pathname = new URL(url).pathname;
    if (cache.has(pathname)) return cache.get(pathname);
    const paths = contentPaths(site, pathname).filter(existsSync).map((path) => relative(root, path));
    if (!paths.length) return undefined;
    let value;
    try {
      const date = execFileSync('git', ['--literal-pathspecs', 'log', '-1', '--format=%cI', '--', ...paths],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (date && Number.isFinite(Date.parse(date))) value = date;
    } catch { /* 不能可靠读取历史时不声称页面更新时间。 */ }
    cache.set(pathname, value);
    return value;
  };
}

export { createLastmod };

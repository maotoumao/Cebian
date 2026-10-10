import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
// 线上 Cloudflare 会追加统计脚本；仅剔除该已知外部空脚本，不放宽正文或其他资源校验。
function contentHash(bytes) {
  const html = bytes.toString().replace(
    /<script\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>\s*<\/script>\r?\n?/gi,
    (script, attributes) => {
      // 完整消费每个属性及其引号值，不能把 data-src 或属性值内的 src 当成真实 src。
      const attribute = /\s+([^\s=<>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>"'=]+)))?/gy;
      const sources = [];
      let end = 0;
      let match;
      while ((match = attribute.exec(attributes))) {
        end = attribute.lastIndex;
        if (match[1].toLowerCase() === 'src') sources.push(match[2] ?? match[3] ?? match[4] ?? '');
      }
      if (attributes.slice(end).trim() || sources.length !== 1) return script;
      return /^https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js(?:\/[^\s]*)?$/.test(sources[0]) ? '' : script;
    });
  return digest(html);
}

function validUrl(value, origin) {
  const url = new URL(value);
  if (url.origin !== origin || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href !== value) {
    throw new Error('Invalid IndexNow URL');
  }
  return url;
}

function validateManifest(manifest) {
  if (manifest?.version !== 1 || new URL(manifest.origin).origin !== manifest.origin || !manifest.pages || Array.isArray(manifest.pages)) {
    throw new Error('Invalid IndexNow manifest');
  }
  for (const [url, hash] of Object.entries(manifest.pages)) {
    validUrl(url, manifest.origin);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid page hash');
  }
}

function createManifest(dist, origin) {
  const xml = readFileSync(resolve(dist, 'sitemap-0.xml'), 'utf8');
  const pages = {};
  // Astro 当前只生成一个 sitemap；只收录已发布 URL，不猜测源文件路由。
  for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const url = validUrl(match[1], origin);
    const file = resolve(dist, `.${decodeURIComponent(url.pathname)}`, 'index.html');
    if (!file.startsWith(resolve(dist) + sep)) throw new Error('Unsafe sitemap URL');
    const html = readFileSync(file);
    if (/<meta\b[^>]*name="robots"[^>]*content="[^"]*noindex/i.test(html.toString())) continue;
    pages[url.href] = contentHash(html);
  }
  if (!Object.keys(pages).length) throw new Error('Empty IndexNow manifest');
  const manifest = { version: 1, origin, pages };
  validateManifest(manifest);
  return manifest;
}

function changedUrls(previous, current) {
  validateManifest(current);
  if (previous) {
    if (previous.origin !== current.origin) throw new Error('Manifest origin mismatch');
    validateManifest(previous);
  }
  const old = previous?.pages ?? {};
  return [...new Set([...Object.keys(old), ...Object.keys(current.pages)])]
    .filter((url) => old[url] !== current.pages[url]).sort();
}

function validateKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9-]{8,128}$/.test(key)) throw new Error('Invalid IndexNow key');
}

async function notifyChanges(previous, current, key, request = fetch) {
  validateKey(key);
  const urls = changedUrls(previous, current);
  if (!urls.length) return { status: null, submitted: 0, urls };
  if (urls.length > 10000) throw new Error('IndexNow batch exceeds 10000 URLs');
  const keyLocation = `${current.origin}/${key}.txt`;
  const get = (url) => request(url, { redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(30000) });
  const keyResponse = await get(keyLocation);
  if (keyResponse.status !== 200 || (await keyResponse.text()).trim() !== key) throw new Error('Live IndexNow key verification failed');
  // 在发送前确认部署内容已可访问。失败保留旧成功基线，后续运行重新计算差异。
  for (const url of urls) {
    const response = await get(url);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (current.pages[url]) {
      if (response.status !== 200 || contentHash(bytes) !== current.pages[url]) throw new Error(`Live content mismatch: ${url}`);
    } else if (![301, 308, 404, 410].includes(response.status)
      && !(response.status === 200 && /<meta\b[^>]*name="robots"[^>]*content="[^"]*noindex/i.test(bytes.toString()))) {
      throw new Error(`URL not removed from indexable content: ${url}`);
    }
  }
  const response = await request('https://api.indexnow.org/indexnow', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: new URL(current.origin).host, key, keyLocation, urlList: urls }),
  });
  if (![200, 202].includes(response.status)) throw new Error(`IndexNow returned HTTP ${response.status}; no automatic POST retry`);
  // 200/202 只代表收到通知；202 仍待验证 key，不代表收录。
  return { status: response.status, submitted: urls.length, urls };
}

export { createManifest, changedUrls, validateKey, notifyChanges };

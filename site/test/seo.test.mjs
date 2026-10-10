import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const dist = new URL('../dist/', import.meta.url);
const page = (path) => readFileSync(new URL(`${path}/index.html`, dist), 'utf8');
const title = (html) => html.match(/<title>(.*?)<\/title>/s)?.[1];
const graph = (html) => [...html.matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)]
  .flatMap((match) => JSON.parse(match[1])['@graph'] ?? []);

test('structured data describes a real app and localized document breadcrumbs without ratings', () => {
  for (const lang of ['zh', 'en', 'zh-TW']) {
    const homeGraph = graph(page(lang));
    const software = homeGraph.find((item) => item['@type'] === 'SoftwareApplication');
    assert.ok(software, 'home must describe the application');
    assert.equal(software['@id'], 'https://cebian.catcat.work/#software');
    assert.equal(software.name, 'Cebian');
    assert.equal(software.isAccessibleForFree, true);
    assert.ok(!('aggregateRating' in software) && !('review' in software));
    assert.ok(homeGraph.some((item) => item['@type'] === 'Person' && item.name === 'maotoumao'));
    const docs = graph(page(`${lang}/docs/reference/providers`));
    const breadcrumbs = docs.find((item) => item['@type'] === 'BreadcrumbList');
    assert.equal(breadcrumbs?.itemListElement.length, 3);
    assert.deepEqual(breadcrumbs.itemListElement.map((item) => item.item), [
      `https://cebian.catcat.work/${lang}/`,
      `https://cebian.catcat.work/${lang}/docs/`,
      `https://cebian.catcat.work/${lang}/docs/reference/providers/`,
    ]);
    assert.equal(docs.filter((item) => item['@type'] === 'SoftwareApplication').length, 0);
  }
  for (const html of [readFileSync(new URL('index.html', dist), 'utf8'), readFileSync(new URL('404.html', dist), 'utf8')]) {
    assert.deepEqual(graph(html), []);
  }
});

test('sitemap includes valid content dates for each published document', () => {
  const xml = readFileSync(new URL('sitemap-0.xml', dist), 'utf8');
  const entries = [...xml.matchAll(/<url>(.*?)<\/url>/gs)];
  const docs = entries.filter((entry) => /\/docs\/[^<]+\//.test(entry[1]));
  assert.equal(docs.length, 39);
  for (const entry of docs) {
    const value = entry[1].match(/<lastmod>(.*?)<\/lastmod>/)?.[1];
    assert.ok(value && Number.isFinite(Date.parse(value)), 'document is missing a real lastmod');
  }
});

test('sharing metadata uses a real large card image in each language', () => {
  for (const lang of ['zh', 'en', 'zh-TW']) {
    const html = page(lang);
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    const url = html.match(/property="og:image" content="([^"]+)"/)?.[1];
    assert.ok(url && !url.endsWith('/icon/128.png'));
    const bytes = readFileSync(new URL(new URL(url).pathname.slice(1), dist));
    assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), 1200);
    assert.equal(bytes.readUInt32BE(20), 630);
    assert.match(html, /property="og:image:alt" content="[^"]+"/);
  }
});

// 验证最终 HTML，而不是只验证 frontmatter 中存在某个配置项。
test('localized search titles describe the product without lengthening document headings', () => {
  for (const lang of ['zh', 'en', 'zh-TW']) {
    const home = page(lang);
    const providers = page(`${lang}/docs/reference/providers`);
    const install = page(`${lang}/docs/getting-started/installation`);
    assert.match(title(home), /MCP/);
    assert.match(title(providers), /Ollama/);
    assert.match(title(install), /Firefox/);
    assert.match(providers, /<h1[^>]*>(Provider 列表|Provider list)<\/h1>/);
    assert.match(providers, new RegExp(`rel="canonical" href="https://cebian.catcat.work/${lang}/docs/reference/providers/"`));
    assert.equal((providers.split('</head>')[0].match(/hreflang=/g) ?? []).length, 4);
  }
});

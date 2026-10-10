import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const site = 'https://cebian.catcat.work';

test('IndexNow verifies live content and key before POST, and reports receipt only', async () => {
  const { notifyChanges } = await import('./indexnow.mjs');
  const { createHash } = await import('node:crypto');
  const body = '<title>Published</title>';
  const current = { version: 1, origin: site, pages: { [`${site}/zh/`]: createHash('sha256').update(body).digest('hex') } };
  const key = 'a'.repeat(32);
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === `${site}/${key}.txt`) return new Response(key);
    if (url === `${site}/zh/`) return new Response(body);
    if (url === 'https://api.indexnow.org/indexnow') return new Response('', { status: 202 });
    throw new Error('Unexpected URL');
  };
  const result = await notifyChanges(null, current, key, request);
  assert.deepEqual(result, { status: 202, submitted: 1, urls: [`${site}/zh/`] });
  const payload = JSON.parse(calls.at(-1).options.body);
  assert.deepEqual(payload, { host: 'cebian.catcat.work', key, keyLocation: `${site}/${key}.txt`, urlList: [`${site}/zh/`] });
  calls.length = 0;
  assert.equal((await notifyChanges(current, current, key, request)).submitted, 0);
  assert.equal(calls.length, 0);
  // CDN 只注入已知的 Cloudflare 统计脚本时，正文仍是同一部署；不忽略其他脚本或文字。
  const beacon = '<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/v123" data-cf-beacon=\'{}\'></script>';
  assert.equal((await notifyChanges(null, current, key, async (url, options) =>
    url === `${site}/zh/` ? new Response(body + beacon) : request(url, options))).submitted, 1);
  await assert.rejects(() => notifyChanges(null, current, key, async (url, options) =>
    url === `${site}/zh/` ? new Response(body + '<script src="https://other.invalid/a.js"></script>') : request(url, options)), /content/);
  for (const script of [
    '<script data-src="https://static.cloudflareinsights.com/beacon.min.js/v123" src="https://other.invalid/a.js"></script>',
    '<script data-note=\' src="https://static.cloudflareinsights.com/beacon.min.js/v123"\' src="https://other.invalid/a.js"></script>',
  ]) {
    await assert.rejects(() => notifyChanges(null, current, key, async (url, options) =>
      url === `${site}/zh/` ? new Response(body + script) : request(url, options)), /content/);
  }
  await assert.rejects(() => notifyChanges(null, current, '../bad-key', request), /key/);
  await assert.rejects(() => notifyChanges(null, current, key, async (url) => new Response(url.endsWith('.txt') ? key : 'stale')), /content/);
  await assert.rejects(() => notifyChanges(null, current, key, async () => new Response('wrong key')), /key/);
  await assert.rejects(() => notifyChanges(null, current, key, async (url, options) => url.startsWith('https://api.') ? new Response('', { status: 429 }) : request(url, options)), /429/);
});

test('IndexNow notifies removal only after the old URL stops serving indexable content', async () => {
  const { notifyChanges } = await import('./indexnow.mjs');
  const key = 'b'.repeat(32);
  const previous = { version: 1, origin: site, pages: { [`${site}/old/`]: 'a'.repeat(64) } };
  const current = { version: 1, origin: site, pages: {} };
  let posts = 0;
  const request = async (url) => {
    if (url.endsWith('.txt')) return new Response(key);
    if (url === `${site}/old/`) return new Response('', { status: 404 });
    posts++; return new Response('', { status: 200 });
  };
  assert.equal((await notifyChanges(previous, current, key, request)).submitted, 1);
  assert.equal(posts, 1);
  await assert.rejects(() => notifyChanges(previous, current, key, async (url) => new Response(url.endsWith('.txt') ? key : '<h1>Still here</h1>')), /removed/);
});


test('IndexNow compares published content, includes removals, and skips unchanged builds', async () => {
  const { createManifest, changedUrls } = await import('./indexnow.mjs');
  const dist = mkdtempSync(join(tmpdir(), 'cebian-indexnow-'));
  const put = (path, body) => { mkdirSync(join(dist, path, '..'), { recursive: true }); writeFileSync(join(dist, path), body); };
  try {
    put('sitemap-0.xml', `<urlset><url><loc>${site}/zh/</loc></url><url><loc>${site}/en/</loc></url></urlset>`);
    put('zh/index.html', '<title>中文</title>');
    put('en/index.html', '<title>English</title>');
    const first = createManifest(dist, site);
    assert.deepEqual(changedUrls(null, first), [`${site}/en/`, `${site}/zh/`]);
    assert.deepEqual(changedUrls(first, createManifest(dist, site)), []);
    put('en/index.html', '<title>Updated English</title>');
    const second = createManifest(dist, site);
    assert.deepEqual(changedUrls(first, second), [`${site}/en/`]);
    put('sitemap-0.xml', `<urlset><url><loc>${site}/en/</loc></url></urlset>`);
    const third = createManifest(dist, site);
    assert.deepEqual(changedUrls(second, third), [`${site}/zh/`]);
    assert.throws(() => changedUrls({ ...first, origin: 'https://other.invalid' }, third), /origin/);
    put('sitemap-0.xml', '<urlset><url><loc>https://other.invalid/en/</loc></url></urlset>');
    assert.throws(() => createManifest(dist, site), /URL/);
  } finally { rmSync(dist, { recursive: true, force: true }); }
});

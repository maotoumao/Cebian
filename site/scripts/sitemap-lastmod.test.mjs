import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// 使用真实 Git 仓库验证日期；避免以构建时钟或文件系统 mtime 冒充更新时间。
test('sitemap dates follow page history, not unrelated commits or a build clock', async () => {
  const { createLastmod } = await import('./sitemap-lastmod.mjs');
  const root = mkdtempSync(join(tmpdir(), 'cebian-lastmod-'));
  const site = join(root, 'site');
  const run = (args, date) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_COMMITTER_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_EMAIL: 'test@example.invalid',
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } });
  const put = (name, body) => { mkdirSync(join(root, name, '..'), { recursive: true }); writeFileSync(join(root, name), body); };
  try {
    run(['init', '-q']);
    put('site/src/content/docs/zh/guides/example/index.mdx', '---\ntitle: Example\n---\nOriginal');
    run(['add', '.']); run(['commit', '-qm', 'initial'], '2025-01-02T10:00:00Z');
    put('unrelated.txt', 'unrelated');
    run(['add', '.']); run(['commit', '-qm', 'unrelated'], '2025-02-03T10:00:00Z');
    const lastmod = createLastmod(site);
    assert.equal(lastmod('https://cebian.catcat.work/zh/docs/guides/example/'), '2025-01-02T10:00:00+00:00');
    assert.equal(lastmod('https://cebian.catcat.work/zh/docs/guides/missing/'), undefined);
    assert.equal(lastmod('https://cebian.catcat.work/not-a-route/'), undefined);
    assert.equal(lastmod('https://cebian.catcat.work/'), undefined);
    const snapshot = lastmod('https://cebian.catcat.work/zh/docs/guides/example/');
    assert.equal(snapshot, lastmod('https://cebian.catcat.work/zh/docs/guides/example/'));
    // 缺失 Git 元数据的源代码包不输出虚构日期。
    const noGit = mkdtempSync(join(tmpdir(), 'cebian-no-git-'));
    try { assert.equal(createLastmod(noGit)('https://cebian.catcat.work/zh/'), undefined); }
    finally { rmSync(noGit, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

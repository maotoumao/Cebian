import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createManifest, notifyChanges, validateKey } from './indexnow.mjs';

const [command, directory] = process.argv.slice(2);
const origin = process.env.SITE_ORIGIN;
const key = process.env.INDEXNOW_KEY;
const artifactName = 'indexnow-manifest';
const state = resolve(directory ?? '.indexnow');
validateKey(key);
if (!origin || new URL(origin).origin !== origin || !origin.startsWith('https://')) throw new Error('Invalid SITE_ORIGIN');

if (command === 'prepare') {
  const manifest = createManifest('dist', origin);
  mkdirSync(state, { recursive: true });
  writeFileSync(resolve(state, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  // key 仅由 Actions secret 注入部署产物，不写入源码或日志。
  writeFileSync(resolve('dist', `${key}.txt`), key, 'utf8');
  console.log(`Prepared IndexNow manifest for ${Object.keys(manifest.pages).length} URLs`);
} else if (command === 'notify') {
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Invalid GITHUB_REPOSITORY');
  const current = JSON.parse(readFileSync(resolve(state, 'manifest.json'), 'utf8'));
  if (current.origin !== origin) throw new Error('Manifest origin does not match deployment');
  // 只认整条工作流成功后的基线：通知失败不会吞掉本次变更；不依赖 git push 的 before。
  const runs = JSON.parse(gh(['run', 'list', '--repo', repository, '--workflow', 'deploy-site.yml',
    '--branch', 'master', '--status', 'success', '--limit', '1', '--json', 'databaseId']));
  let previous = null;
  if (runs.length) {
    const run = String(runs[0].databaseId);
    const data = JSON.parse(gh(['api', `repos/${repository}/actions/runs/${run}/artifacts?per_page=100`]));
    const artifact = data.artifacts.find((item) => item.name === artifactName && !item.expired);
    if (artifact) {
      const old = resolve(state, 'previous');
      gh(['run', 'download', run, '--repo', repository, '--name', artifactName, '--dir', old]);
      previous = JSON.parse(readFileSync(resolve(old, 'manifest.json'), 'utf8'));
    }
  }
  if (!previous) console.log('No retained successful baseline: bootstrap with current published URLs; historical removals are unknown.');
  const result = await notifyChanges(previous, current, key);
  writeFileSync(resolve(state, 'receipt.json'), JSON.stringify(result, null, 2) + '\n');
  const summary = result.submitted === 0 ? 'IndexNow: no content changes; no request sent.'
    : `IndexNow: HTTP ${result.status}, ${result.submitted} URL notifications received${result.status === 202 ? '; key validation pending' : ''}. This does not confirm indexing.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
} else {
  throw new Error('Usage: node scripts/indexnow-cli.mjs prepare|notify <state-directory>');
}

// 由簡體 zh 文件批次產生繁體 zh-TW 文件（OpenCC cn → twp：簡體 → 臺灣正體含詞彙轉換）。
//
// 用法：pnpm gen:zhtw
//
// zh-TW/**/index.mdx 是「自動產生」的衍生檔案：請改 zh 原文，再重跑本腳本，
// 不要直接編輯 zh-TW。imports / JSX / 程式碼 / URL 為拉丁字元，OpenCC 不會更動，
// 只轉換中文字，因此整檔轉換是安全的。
import { readdir, readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as OpenCC from 'opencc-js';

const root = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(root, 'src/content/docs/zh');
const OUT = join(root, 'src/content/docs/zh-TW');

const convert = OpenCC.Converter({ from: 'cn', to: 'twp' });

// 自動產生標記：放在 frontmatter 之後（MDX 註解，渲染為空），提醒勿手動編輯。
const MARKER =
  '{/* AUTO-GENERATED from docs/zh by scripts/gen-zhtw.mjs — do not edit; edit zh then run `pnpm gen:zhtw`. */}';

function withMarker(mdx) {
  const m = mdx.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  if (!m) return `${MARKER}\n\n${mdx}`;
  const fm = m[0];
  return `${fm}\n${MARKER}\n${mdx.slice(fm.length)}`;
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name === 'index.mdx') yield full;
  }
}

// 整檔轉換為繁體後，把站內連結的語言前綴 /zh/ 改寫成 /zh-TW/，
// 否則繁體頁面會把使用者帶回簡體文件。
function localizeLinks(mdx) {
  return mdx.split('](/zh/').join('](/zh-TW/');
}

// 先清空 zh-TW 目錄再重建，確保產出冪等：zh 刪除 / 改名的頁面不會殘留陳舊路由。
await rm(OUT, { recursive: true, force: true });

let count = 0;
let assets = 0;
for await (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  const out = join(OUT, rel);
  const converted = withMarker(localizeLinks(convert(await readFile(file, 'utf8'))));
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, converted, 'utf8');
  count++;
  console.log(`  ${rel}`);

  // 同目錄下與 index.mdx 並列的資產（截圖等，透過 Markdown ./xxx.png 相對引用）
  // 必須一併複製到 zh-TW 目錄，否則衍生文件解析相對路徑會失敗。
  const srcDir = dirname(file);
  for (const sibling of await readdir(srcDir, { withFileTypes: true })) {
    if (sibling.isDirectory() || sibling.name === 'index.mdx') continue;
    await copyFile(join(srcDir, sibling.name), join(dirname(out), sibling.name));
    assets++;
  }
}
console.log(`zh-TW docs generated: ${count} file(s), ${assets} asset(s) copied.`);

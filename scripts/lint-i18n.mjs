#!/usr/bin/env node
/**
 * lint-i18n.mjs — temporary helper for the i18n migration.
 *
 * Two checks:
 *  1. Scans Cebian source for hard-coded Chinese characters in user-facing
 *     positions (JSX text, string literals in components/entrypoints) and
 *     prints a report.
 *  2. Asserts the top-level keys in `locales/en.yml`, `locales/zh_CN.yml`,
 *     and `locales/zh_TW.yml` match the approved allow-list (the manifest
 *     exception + namespace namespaces). Catches accidental flat keys
 *     like top-level `cancel: ...`.
 *  3. Asserts top-level key parity across all three locale files.
 *
 * Intended to track migration progress; does NOT fail the build.
 *
 * DELETE this script (and the `lint:i18n` package.json entry) once the
 * extraction migration is complete.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SCAN_DIRS = ['components', 'entrypoints', 'lib'];
const EXTENSIONS = new Set(['.ts', '.tsx']);

// Files exempt from scanning (i18n source, design files, generated, etc.)
const EXEMPT_FILE_REGEXES = [
  /[\\/]locales[\\/]/,
  /[\\/]\.output[\\/]/,
  /[\\/]node_modules[\\/]/,
  /[\\/]design[\\/]/,
  // i18n wrapper itself contains comments, but no zh strings.
];

const CJK_RE = /[\u4e00-\u9fa5]/;

// Allow-list of top-level keys in locales/*.yml. Any other top-level key
// indicates a namespace violation per the i18n-naming skill.
const ALLOWED_TOP_KEYS = new Set([
  // Manifest exception (Chrome __MSG_*__ does not allow dots in key).
  'extName', 'extDescription', 'actionTitle',
  // Namespaces.
  'common', 'chat', 'settings', 'provider', 'dialogs', 'errors', 'agent',
]);

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (EXEMPT_FILE_REGEXES.some((re) => re.test(full))) continue;
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

async function scanFile(absPath) {
  const text = await fs.readFile(absPath, 'utf8');
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip pure comment lines.
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    if (CJK_RE.test(line)) {
      hits.push({ lineNo: i + 1, line: line.trim() });
    }
  }
  return hits;
}

/**
 * Read top-level keys from a YAML file. Naive parser: looks for
 * `<word>:` at column 0 (no indent). Sufficient because the i18n YAML
 * shape is always `key:` or `key: "value"` at top level.
 */
async function topLevelKeys(yamlPath) {
  const text = await fs.readFile(yamlPath, 'utf8');
  const keys = new Set();
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith(' ') || raw.startsWith('\t')) continue;
    if (raw.startsWith('#') || raw.trim() === '') continue;
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/**
 * Read all flat dotted key paths from a YAML file (e.g. `common.send`,
 * `chat.notice.0`). Naive indentation parser sufficient for our
 * constrained locale shape: nested string maps + scalar leaves. Each
 * indent level uses 2 spaces.
 */
async function flatKeyPaths(yamlPath) {
  const text = await fs.readFile(yamlPath, 'utf8');
  const stack = []; // [{ key, indent }]
  const paths = new Set();
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    const indentMatch = raw.match(/^( *)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    const line = raw.slice(indent);
    const m = line.match(/^("?)([A-Za-z_0-9][A-Za-z_0-9-]*)\1\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[2];
    const rest = m[3];
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ key, indent });
    if (rest !== '') {
      // leaf scalar (quoted or unquoted)
      paths.add(stack.map((s) => s.key).join('.'));
    }
  }
  return paths;
}

async function checkLocaleAllowList() {
  const violations = [];
  for (const file of ['locales/en.yml', 'locales/zh_CN.yml', 'locales/zh_TW.yml']) {
    const abs = path.join(ROOT, file);
    let keys;
    try { keys = await topLevelKeys(abs); } catch { continue; }
    for (const k of keys) {
      if (!ALLOWED_TOP_KEYS.has(k)) {
        violations.push({ file, key: k });
      }
    }
  }
  return violations;
}

async function checkKeyParity() {
  const files = ['locales/en.yml', 'locales/zh_CN.yml', 'locales/zh_TW.yml'];
  const keySets = {};
  const readErrors = [];
  for (const f of files) {
    try {
      keySets[f] = await flatKeyPaths(path.join(ROOT, f));
    } catch (err) {
      readErrors.push({ file: f, message: err?.message ?? String(err) });
    }
  }
  const present = Object.keys(keySets);
  const union = new Set();
  for (const f of present) for (const k of keySets[f]) union.add(k);
  const missing = [];
  for (const f of present) {
    for (const k of union) {
      if (!keySets[f].has(k)) missing.push({ file: f, key: k });
    }
  }
  return { missing, readErrors };
}

async function main() {
  // ─── 1. Top-level YAML key allow-list check ───
  const localeViolations = await checkLocaleAllowList();
  if (localeViolations.length > 0) {
    console.log(`✗ i18n lint: ${localeViolations.length} disallowed top-level locale key(s):`);
    for (const { file, key } of localeViolations) {
      console.log(`  ${file}: \`${key}\` — not in allow-list (see .agents/skills/i18n-naming/SKILL.md)`);
    }
    console.log('');
  } else {
    console.log('✓ i18n lint: locale top-level keys conform to allow-list.');
  }

  // ─── 1b. Full key parity (flat paths) across en/zh_CN/zh_TW ───
  const { missing: parityMissing, readErrors } = await checkKeyParity();
  for (const { file, message } of readErrors) {
    console.log(`✗ i18n lint: failed to read ${file}: ${message}`);
  }
  if (parityMissing.length > 0) {
    console.log(`✗ i18n lint: ${parityMissing.length} key parity gap(s) (flat paths):`);
    for (const { file, key } of parityMissing) {
      console.log(`  ${file}: missing \`${key}\``);
    }
    console.log('');
  } else if (readErrors.length === 0) {
    console.log('✓ i18n lint: all keys are in parity across en/zh_CN/zh_TW.');
  }

  // ─── 2. Source scan for hard-coded Chinese ───
  const fileHits = [];
  let totalLines = 0;

  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    for await (const file of walk(abs)) {
      const hits = await scanFile(file);
      if (hits.length > 0) {
        fileHits.push({ file: path.relative(ROOT, file), hits });
        totalLines += hits.length;
      }
    }
  }

  if (fileHits.length === 0) {
    console.log('✓ i18n lint: no Chinese characters found in scanned source.');
    return;
  }

  console.log(`i18n lint: ${totalLines} line(s) with Chinese across ${fileHits.length} file(s)`);
  console.log('---');
  for (const { file, hits } of fileHits) {
    console.log(`\n${file}  (${hits.length})`);
    for (const { lineNo, line } of hits) {
      const display = line.length > 120 ? line.slice(0, 117) + '...' : line;
      console.log(`  L${String(lineNo).padStart(4, ' ')}  ${display}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

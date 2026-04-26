/**
 * Skill package import/export — pack a Skill directory into a plain zip
 * and restore it back into the VFS.
 *
 * Format
 * ======
 *
 * The zip is a literal mirror of the Skill directory contents — no
 * manifest JSON, no wrapper folders. This means a user can unzip a
 * package, inspect/edit `SKILL.md`, re-zip it with any tool, and it still
 * imports correctly.
 *
 * Single-skill package (`<name>.cebian-skill.zip`):
 *
 *     SKILL.md            ← required, at zip root
 *     scripts/...
 *     references/...
 *
 * Full backup package (`cebian-skills-backup-YYYY-MM-DD.zip`):
 *
 *     <skill-a>/SKILL.md
 *     <skill-a>/scripts/...
 *     <skill-b>/SKILL.md
 *
 * Type detection: if `SKILL.md` is at the zip root → single-skill package;
 * otherwise the zip is treated as a backup (one subdirectory per skill,
 * each containing its own `SKILL.md`).
 *
 * Safety
 * ======
 *
 * `inspectSkillPackage` rejects packages that violate any size/path/permission
 * rule before we touch the VFS. Limits are intentionally small — Skills are
 * meant to be lightweight prompt+script bundles, not asset dumps.
 *
 * Conflict resolution
 * ===================
 *
 * Two strategies. `rename` appends `-1`, `-2`, ... until free (matches
 * `createSkillTemplate`'s scheme). `overwrite` deletes the existing directory
 * AND clears any "always allow" permission grant for that name — replacing a
 * skill with new code MUST require fresh user consent before the new scripts
 * can run with elevated permissions.
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { vfs, normalizePath } from '@/lib/vfs';
import { CEBIAN_SKILLS_DIR, SKILL_ENTRY_FILE } from '@/lib/constants';
import { parseFrontmatter } from './frontmatter';
import { CHROME_API_WHITELIST } from '@/lib/tools/chrome-api-whitelist';
import { clearSkillGrant } from './skill-grants';

// ─── Limits ───

/** Maximum unzipped total size of a package, in bytes. */
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
/** Maximum unzipped size of a single file inside a package, in bytes. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Maximum number of files inside a package. */
const MAX_FILES = 200;
/** Skill directory name pattern — same rules as builtin-skill-creator:
 *  1–64 chars, lowercase a–z / digits / hyphens, no leading or trailing
 *  hyphen, no `--`. */
const SKILL_NAME_RE = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;
/** Reserved prefix for built-in skills shipped by Cebian. */
const RESERVED_PREFIX = 'builtin-';

// ─── Public types ───

export interface SkillImportPreviewItem {
  /** Directory name as found inside the zip. */
  sourceDirName: string;
  /** Final directory name after applying the conflict strategy. */
  targetDirName: string;
  /** True when the source name already exists in the VFS. */
  conflicts: boolean;
  /** Frontmatter `name` (may differ from directory name). */
  name: string;
  description: string;
  permissions: string[];
  hasScripts: boolean;
  fileCount: number;
  totalBytes: number;
}

export interface SkillImportPreview {
  packageType: 'cebian.skill' | 'cebian.skills.backup';
  items: SkillImportPreviewItem[];
  /** Non-fatal observations the UI should surface. */
  warnings: string[];
}

export type ConflictStrategy = 'rename' | 'overwrite';

export interface SkillImportOptions {
  conflictStrategy: ConflictStrategy;
}

export interface SkillImportResult {
  installed: Array<{ targetDirName: string; overwritten: boolean }>;
}

/** Localized error code emitted by inspect/import. UI maps these to i18n. */
export class SkillPackageError extends Error {
  constructor(
    /** i18n key suffix under `errors.skillPackage.*`. */
    readonly code:
      | 'invalid'
      | 'tooLarge'
      | 'tooManyFiles'
      | 'missingEntry'
      | 'unsafePath'
      | 'unsupportedPermission'
      | 'invalidName'
      | 'reservedName'
      | 'parseFrontmatter',
    /** Optional positional placeholder ($1) for the i18n string. */
    readonly arg?: string,
  ) {
    super(`SkillPackageError(${code})${arg ? `: ${arg}` : ''}`);
    this.name = 'SkillPackageError';
  }
}

// ─── Path safety ───

/** Junk entries common in macOS/Windows zips that we silently drop on import. */
function isJunkPath(p: string): boolean {
  if (p.startsWith('__MACOSX/')) return true;
  const base = p.split('/').pop() ?? '';
  if (base === '.DS_Store' || base === 'Thumbs.db') return true;
  return false;
}

/**
 * Validate a relative POSIX path inside a package. Throws SkillPackageError
 * with code `unsafePath` for anything that could escape its container.
 */
function assertSafeRelPath(p: string): void {
  if (!p) throw new SkillPackageError('unsafePath', '<empty>');
  if (p.includes('\\')) throw new SkillPackageError('unsafePath', p);
  // Control chars & NUL.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(p)) throw new SkillPackageError('unsafePath', p);
  if (p.startsWith('/')) throw new SkillPackageError('unsafePath', p);
  // Reject Windows drive letters like `C:`.
  if (/^[a-zA-Z]:/.test(p)) throw new SkillPackageError('unsafePath', p);
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new SkillPackageError('unsafePath', p);
    }
  }
}

/** Throws if the directory name is not a portable Skill name. */
function assertSkillName(name: string): void {
  if (name.startsWith(RESERVED_PREFIX)) {
    throw new SkillPackageError('reservedName', name);
  }
  if (!SKILL_NAME_RE.test(name)) {
    throw new SkillPackageError('invalidName', name);
  }
}

/** Validate every declared permission against the runtime whitelist. */
function assertPermissionsAllowed(permissions: string[]): void {
  for (const p of permissions) {
    if (p === 'page.executeJs') continue;
    const m = /^chrome\.([a-zA-Z][a-zA-Z0-9]*)$/.exec(p);
    // hasOwnProperty guard: avoid accepting inherited names like
    // "chrome.constructor" or "chrome.toString" as legitimate permissions.
    if (m && Object.prototype.hasOwnProperty.call(CHROME_API_WHITELIST, m[1])) continue;
    throw new SkillPackageError('unsupportedPermission', p);
  }
}

// ─── VFS walk ───

/** Recursively list all files under an absolute VFS dir, returning POSIX
 *  paths relative to that dir. */
async function walkVfs(rootAbs: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(currentAbs: string, relPrefix: string): Promise<void> {
    const entries = await vfs.readdir(currentAbs);
    for (const entry of entries) {
      const childAbs = `${currentAbs}/${entry}`;
      const rel = relPrefix ? `${relPrefix}/${entry}` : entry;
      const info = await vfs.stat(childAbs);
      if (info.isDirectory()) {
        await recurse(childAbs, rel);
      } else if (info.isFile()) {
        out.push(rel);
      }
    }
  }
  await recurse(rootAbs, '');
  return out;
}

// ─── Frontmatter helpers ───

interface SkillFrontmatter {
  name: string;
  description: string;
  permissions: string[];
}

function readSkillFrontmatter(skillMd: string): SkillFrontmatter {
  let parsed;
  try {
    parsed = parseFrontmatter(skillMd);
  } catch {
    throw new SkillPackageError('parseFrontmatter');
  }
  const data = parsed.data;
  const name = typeof data.name === 'string' ? data.name : '';
  const description = typeof data.description === 'string' ? data.description : '';
  let permissions: string[] = [];
  if (data.metadata && typeof data.metadata === 'object') {
    const meta = data.metadata as Record<string, unknown>;
    if (Array.isArray(meta.permissions)) {
      permissions = meta.permissions.filter((p): p is string => typeof p === 'string');
    }
  }
  return { name, description, permissions };
}

// ─── Export ───

/**
 * Read all files of a Skill directory and pack them flat into a zip.
 * The zip mirrors the directory contents exactly: `SKILL.md` at the root,
 * and any subdirectories like `scripts/` / `references/` preserved as-is.
 *
 * `skillAbsDir` must be an absolute VFS path under `~/.cebian/skills/`.
 */
export async function exportSkillPackage(skillAbsDir: string): Promise<Blob> {
  const fileList = await walkVfs(skillAbsDir);
  if (!fileList.includes(SKILL_ENTRY_FILE)) {
    throw new SkillPackageError('missingEntry');
  }
  const zipMap: Record<string, Uint8Array> = {};
  for (const rel of fileList) {
    const raw = await vfs.readFile(`${skillAbsDir}/${rel}`);
    zipMap[rel] = raw instanceof Uint8Array ? raw : strToU8(raw as string);
  }
  return new Blob([zipSync(zipMap) as BlobPart], { type: 'application/zip' });
}

/**
 * Export every Skill currently present under `~/.cebian/skills/` into a
 * single backup zip. Each skill becomes a top-level subdirectory inside
 * the zip — there is no extra wrapper folder. Skills with no SKILL.md
 * are silently skipped (they can't be re-imported without one anyway).
 *
 * Throws `missingEntry` when no exportable skills exist, so the UI can
 * surface a clear "nothing to back up" message instead of silently
 * downloading an empty (and unimportable) zip.
 */
export async function exportAllSkillsPackage(): Promise<{ blob: Blob; count: number }> {
  const skillsRoot = normalizePath(CEBIAN_SKILLS_DIR);
  let dirNames: string[];
  try {
    dirNames = await vfs.readdir(skillsRoot);
  } catch {
    dirNames = [];
  }

  const zipMap: Record<string, Uint8Array> = {};
  let count = 0;
  for (const dirName of dirNames) {
    const dirAbs = `${skillsRoot}/${dirName}`;
    let stat;
    try { stat = await vfs.stat(dirAbs); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const fileList = await walkVfs(dirAbs);
    if (!fileList.includes(SKILL_ENTRY_FILE)) continue;

    for (const rel of fileList) {
      const raw = await vfs.readFile(`${dirAbs}/${rel}`);
      zipMap[`${dirName}/${rel}`] = raw instanceof Uint8Array ? raw : strToU8(raw as string);
    }
    count++;
  }

  if (count === 0) throw new SkillPackageError('missingEntry');
  return { blob: new Blob([zipSync(zipMap) as BlobPart], { type: 'application/zip' }), count };
}

// ─── Import: shared parsing ───

interface ParsedPackage {
  packageType: 'cebian.skill' | 'cebian.skills.backup';
  /** Map of `<dirName>` → list of files keyed by their path RELATIVE to the
   *  skill root. For single-skill packages there is exactly one entry whose
   *  key is the empty string (the caller picks a name from frontmatter). */
  perSkill: Map<string, Map<string, Uint8Array>>;
  warnings: string[];
}

/**
 * Decode the zip, reject junk, enforce size/count limits, and split files
 * by destination skill. Permission/name validation happens later in
 * `inspectSkillPackage` so the caller gets a richer error report.
 *
 * Type detection rule: a file named exactly `SKILL.md` at the zip root
 * marks the package as a single-skill package; otherwise every file must
 * live under a `<skill-name>/...` subdirectory and the package is treated
 * as a backup.
 */
function parsePackage(blob: ArrayBuffer): ParsedPackage {
  let entries: ReturnType<typeof unzipSync>;
  try {
    entries = unzipSync(new Uint8Array(blob));
  } catch {
    throw new SkillPackageError('invalid');
  }

  // Pre-pass: drop junk, enforce limits, collect raw entries. Order matters:
  // path safety is validated before any size accounting so a malformed entry
  // doesn't first get counted against the totals it would never reach.
  const allFiles: Array<{ zipPath: string; bytes: Uint8Array }> = [];
  let totalBytes = 0;
  for (const [zipPath, bytes] of Object.entries(entries)) {
    if (zipPath.endsWith('/')) continue; // directory entries
    if (isJunkPath(zipPath)) continue;
    assertSafeRelPath(zipPath);
    if (bytes.byteLength > MAX_FILE_BYTES) throw new SkillPackageError('tooLarge');
    if (allFiles.length >= MAX_FILES) throw new SkillPackageError('tooManyFiles');
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) throw new SkillPackageError('tooLarge');
    allFiles.push({ zipPath, bytes });
  }

  if (allFiles.length === 0) throw new SkillPackageError('invalid');

  const isSingle = allFiles.some((f) => f.zipPath === SKILL_ENTRY_FILE);
  const perSkill = new Map<string, Map<string, Uint8Array>>();

  if (isSingle) {
    // Single-skill package: pack every entry as-is under the implicit root
    // skill. Subdirectories like `scripts/` and `references/` are preserved
    // verbatim because the zip is meant to mirror the on-disk layout.
    const bucket = new Map<string, Uint8Array>();
    for (const f of allFiles) {
      bucket.set(f.zipPath, f.bytes);
    }
    perSkill.set('', bucket);
    return { packageType: 'cebian.skill', perSkill, warnings: [] };
  }

  // Backup package: every file must live under `<dirName>/<rest>` where
  // `<dirName>` has no leading dot and is itself a valid relative segment.
  // Reject any stray top-level file (it would have nowhere to belong).
  for (const f of allFiles) {
    const slash = f.zipPath.indexOf('/');
    if (slash <= 0) throw new SkillPackageError('invalid');
    const dirName = f.zipPath.slice(0, slash);
    const rel = f.zipPath.slice(slash + 1);
    if (!rel) throw new SkillPackageError('unsafePath', f.zipPath);
    let bucket = perSkill.get(dirName);
    if (!bucket) {
      bucket = new Map<string, Uint8Array>();
      perSkill.set(dirName, bucket);
    }
    bucket.set(rel, f.bytes);
  }
  // Invariant: empty zips are rejected above and any non-empty path in the
  // backup branch adds a bucket, so `perSkill.size > 0` here by construction.
  return { packageType: 'cebian.skills.backup', perSkill, warnings: [] };
}

/**
 * Parse + validate a package and report what would be imported, given the
 * current state of the VFS. Does NOT touch the VFS itself.
 *
 * Supports both single-skill packages and full backups — the UI uses
 * `packageType` and the items list to decide what to render.
 */
export async function inspectSkillPackage(blob: Blob): Promise<SkillImportPreview> {
  const parsed = parsePackage(await blob.arrayBuffer());
  const skillsRoot = normalizePath(CEBIAN_SKILLS_DIR);
  const items: SkillImportPreviewItem[] = [];

  for (const [zipDirName, fileMap] of parsed.perSkill) {
    const skillMdBytes = fileMap.get(SKILL_ENTRY_FILE);
    if (!skillMdBytes) throw new SkillPackageError('missingEntry');

    const fm = readSkillFrontmatter(strFromU8(skillMdBytes));
    assertPermissionsAllowed(fm.permissions);

    // For single-skill packages the zip does not carry a directory name,
    // so we fall back to the frontmatter `name` (and finally a generic
    // placeholder). For backups, the zip directory is the source of truth.
    const sourceDirName = zipDirName || fm.name || 'imported-skill';
    assertSkillName(sourceDirName);

    const conflicts = await vfs.exists(`${skillsRoot}/${sourceDirName}`);
    const targetDirName = conflicts
      ? await uniqueSkillName(skillsRoot, sourceDirName)
      : sourceDirName;

    const fileEntries = Array.from(fileMap.entries());
    items.push({
      sourceDirName,
      targetDirName,
      conflicts,
      name: fm.name || sourceDirName,
      description: fm.description,
      permissions: fm.permissions,
      hasScripts: fileEntries.some(([rel]) => rel.startsWith('scripts/')),
      fileCount: fileEntries.length,
      totalBytes: fileEntries.reduce((sum, [, bytes]) => sum + bytes.byteLength, 0),
    });
  }

  return { packageType: parsed.packageType, items, warnings: parsed.warnings };
}

/**
 * Apply an import. Re-parses + re-validates the blob (so the same package
 * the user reviewed in the preview is the same one written to disk — we
 * never trust a stale `SkillImportPreview` object), then writes files.
 *
 * On `overwrite`, the existing directory is removed AND the stored "always
 * allow" permission grant for that name is cleared, forcing the user to
 * re-confirm before any new script can run with elevated permissions.
 */
export async function importSkillPackage(
  blob: Blob,
  options: SkillImportOptions,
): Promise<SkillImportResult> {
  const parsed = parsePackage(await blob.arrayBuffer());
  const skillsRoot = normalizePath(CEBIAN_SKILLS_DIR);
  const installed: SkillImportResult['installed'] = [];

  // Pre-pass: validate every skill in the package BEFORE writing any of
  // them. Without this, a backup `[A, B]` where B has an unsupported
  // permission would still write A to disk (and on `overwrite` would have
  // already cleared A's permission grant). Atomic-ish behavior matters
  // most for backups; for a single-skill package this is just a cheap
  // re-check of what `inspectSkillPackage` already did.
  const validated: Array<{
    zipDirName: string;
    fileMap: Map<string, Uint8Array>;
    sourceDirName: string;
  }> = [];
  for (const [zipDirName, fileMap] of parsed.perSkill) {
    const skillMdBytes = fileMap.get(SKILL_ENTRY_FILE);
    if (!skillMdBytes) throw new SkillPackageError('missingEntry');
    const fm = readSkillFrontmatter(strFromU8(skillMdBytes));
    assertPermissionsAllowed(fm.permissions);
    const sourceDirName = zipDirName || fm.name || 'imported-skill';
    assertSkillName(sourceDirName);
    validated.push({ zipDirName, fileMap, sourceDirName });
  }

  for (const { fileMap, sourceDirName } of validated) {
    let targetDirName = sourceDirName;
    let overwritten = false;
    const sourceExists = await vfs.exists(`${skillsRoot}/${sourceDirName}`);
    if (sourceExists) {
      if (options.conflictStrategy === 'overwrite') {
        await vfs.rm(`${skillsRoot}/${sourceDirName}`, { recursive: true, force: true });
        await clearSkillGrant(sourceDirName);
        overwritten = true;
      } else {
        targetDirName = await uniqueSkillName(skillsRoot, sourceDirName);
      }
    }

    const targetAbs = `${skillsRoot}/${targetDirName}`;
    await vfs.mkdir(targetAbs, { recursive: true });
    for (const [rel, bytes] of fileMap) {
      await vfs.writeFile(`${targetAbs}/${rel}`, bytes);
    }
    installed.push({ targetDirName, overwritten });
  }

  return { installed };
}

// ─── Naming ───

/**
 * Find a free `<base>` / `<base>-1` / ... name under `dir`. Mirrors the
 * scheme used by `createSkillTemplate` so import collisions and "new
 * skill" collisions look the same to the user.
 *
 * `base` is truncated (and any resulting trailing hyphen trimmed) to leave
 * room for a `-NNN` suffix without overflowing the 64-char skill-name cap.
 */
export async function uniqueSkillName(dir: string, base: string): Promise<string> {
  if (!(await vfs.exists(`${dir}/${base}`))) return base;
  // Reserve up to 4 chars for `-N` ... `-999`; trim trailing hyphen so the
  // result still satisfies SKILL_NAME_RE.
  const MAX_BASE_LEN = 60;
  let safeBase = base.length > MAX_BASE_LEN ? base.slice(0, MAX_BASE_LEN) : base;
  while (safeBase.endsWith('-')) safeBase = safeBase.slice(0, -1);
  if (!safeBase) safeBase = 'imported-skill';
  for (let n = 1; n < 1000; n++) {
    const candidate = `${safeBase}-${n}`;
    if (!(await vfs.exists(`${dir}/${candidate}`))) return candidate;
  }
  // 1000 collisions on the same base name is a runaway script, not a real
  // user. Fall back to a UUID-suffixed name rather than spinning forever.
  return `${safeBase}-${crypto.randomUUID().slice(0, 8)}`;
}
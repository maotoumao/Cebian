/**
 * Virtual File System — Node.js fs/promises-like API backed by IndexedDB.
 *
 * Uses @isomorphic-git/lightning-fs under the hood.
 * Import { vfs } anywhere to read/write files in a persistent virtual FS.
 *
 * IndexedDB database: "cebian-vfs" (separate from Dexie's "cebian" DB).
 *
 * NOTE: Do NOT import this module from content scripts — IndexedDB is scoped
 * to the host page origin there, not the extension origin.
 */
import FS from '@isomorphic-git/lightning-fs';

// Lazy-initialized singleton — defers IndexedDB connection until first use.
let _pfs: FS.PromisifiedFS | null = null;
function pfs(): FS.PromisifiedFS {
  if (!_pfs) _pfs = new FS('cebian-vfs').promises;
  return _pfs;
}

// ─── Helpers ───

/**
 * Normalize a virtual path: resolve `.` / `..`, deduplicate slashes,
 * strip trailing slash, ensure absolute. Prevents path confusion from
 * agent-generated inputs.
 */
function normalizePath(p: string): string {
  if (!p || p[0] !== '/') p = '/' + p;
  const parts = p.split('/');
  const resolved: string[] = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { resolved.pop(); continue; }
    resolved.push(seg);
  }
  return '/' + resolved.join('/');
}

/** Return the parent directory of a file path. */
function parentDir(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx <= 0 ? '/' : filePath.slice(0, idx);
}

// ─── Extended methods ───

interface MkdirOptions {
  recursive?: boolean;
  mode?: number;
}

/**
 * Create a directory. Supports `{ recursive: true }` like Node.js.
 */
async function mkdir(dirPath: string, opts?: MkdirOptions | number): Promise<void> {
  dirPath = normalizePath(dirPath);
  const recursive = typeof opts === 'object' && opts?.recursive;
  const mode = typeof opts === 'number' ? opts : (typeof opts === 'object' ? opts?.mode : undefined);
  const mkdirOpts = mode !== undefined ? { mode } : undefined;

  if (!recursive) {
    return pfs().mkdir(dirPath, mkdirOpts);
  }

  const parts = dirPath.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += '/' + part;
    try {
      await pfs().mkdir(current, mkdirOpts);
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

/**
 * Remove a file or directory. Supports `{ recursive: true, force: true }` like Node.js.
 */
async function rm(targetPath: string, opts?: RmOptions): Promise<void> {
  targetPath = normalizePath(targetPath);
  const recursive = opts?.recursive ?? false;
  const force = opts?.force ?? false;

  let info;
  try {
    info = await pfs().stat(targetPath);
  } catch (e: any) {
    if (force && e.code === 'ENOENT') return;
    throw e;
  }

  if (info.isFile() || info.isSymbolicLink()) {
    return pfs().unlink(targetPath);
  }

  if (!info.isDirectory()) return;

  if (recursive) {
    const entries = await pfs().readdir(targetPath);
    for (const entry of entries) {
      const childPath = targetPath === '/' ? `/${entry}` : `${targetPath}/${entry}`;
      await rm(childPath, { recursive: true, force });
    }
  }

  return pfs().rmdir(targetPath);
}

/**
 * Check if a file/directory exists (like `fs.promises.access`).
 * Throws ENOENT if it doesn't exist.
 */
async function access(targetPath: string): Promise<void> {
  await pfs().stat(normalizePath(targetPath));
}

/**
 * Check whether a path exists. Convenience wrapper over access().
 */
async function exists(targetPath: string): Promise<boolean> {
  try {
    await pfs().stat(normalizePath(targetPath));
    return true;
  } catch {
    return false;
  }
}

type WriteFileOpts = 'utf8' | { encoding?: 'utf8'; mode?: number };

/**
 * Write a file, automatically creating parent directories.
 * NOTE: This deviates from Node.js fs.promises.writeFile which throws ENOENT
 * when the parent directory doesn't exist. This is intentional for convenience.
 */
async function writeFile(
  filePath: string,
  data: string | Uint8Array,
  opts?: WriteFileOpts,
): Promise<void> {
  filePath = normalizePath(filePath);
  const dir = parentDir(filePath);
  if (dir !== '/') {
    await mkdir(dir, { recursive: true });
  }
  return pfs().writeFile(filePath, data, opts);
}

/**
 * Append data to a file (read + concatenate + write).
 * NOTE: Not atomic — concurrent appends to the same file may lose writes.
 */
async function appendFile(
  filePath: string,
  data: string,
  opts?: 'utf8' | { encoding?: 'utf8' },
): Promise<void> {
  filePath = normalizePath(filePath);
  let existing = '';
  try {
    existing = (await pfs().readFile(filePath, 'utf8')) as string;
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  await writeFile(filePath, existing + data, opts);
}

/**
 * Copy a file from src to dest.
 */
async function copyFile(src: string, dest: string): Promise<void> {
  src = normalizePath(src);
  dest = normalizePath(dest);
  const data = await pfs().readFile(src);
  await writeFile(dest, data as Uint8Array);
}

// ─── Public API (fs/promises-like) ───

// Typed wrappers instead of .bind() to preserve overload signatures
export const vfs = {
  readFile(path: string, opts?: 'utf8' | { encoding?: 'utf8' }) {
    return pfs().readFile(normalizePath(path), opts);
  },
  readdir(path: string) {
    return pfs().readdir(normalizePath(path));
  },
  stat(path: string) {
    return pfs().stat(normalizePath(path));
  },
  lstat(path: string) {
    return pfs().lstat(normalizePath(path));
  },
  rename(oldPath: string, newPath: string) {
    return pfs().rename(normalizePath(oldPath), normalizePath(newPath));
  },
  symlink(target: string, path: string) {
    return pfs().symlink(target, normalizePath(path));
  },
  readlink(path: string) {
    return pfs().readlink(normalizePath(path));
  },
  unlink(path: string) {
    return pfs().unlink(normalizePath(path));
  },
  rmdir(path: string) {
    return pfs().rmdir(normalizePath(path));
  },
  du(path: string) {
    return pfs().du(normalizePath(path));
  },

  // Enhanced / polyfilled
  mkdir,
  writeFile,
  rm,
  access,
  exists,
  appendFile,
  copyFile,
};

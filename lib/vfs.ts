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
import { CEBIAN_HOME } from './constants';

// Lazy-initialized singleton — defers IndexedDB connection until first use.
let _pfs: FS.PromisifiedFS | null = null;
function pfs(): FS.PromisifiedFS {
  if (!_pfs) _pfs = new FS('cebian-vfs').promises;
  return _pfs;
}

// ─── Bootstrap: ensure default directories exist ───

const DEFAULT_DIRS = [
  '/home', '/home/user', CEBIAN_HOME,
  `${CEBIAN_HOME}/skills`, `${CEBIAN_HOME}/prompts`,
  '/workspaces',
];
let _bootstrapPromise: Promise<void> | null = null;

/**
 * Ensure /home/user and /workspace directories exist.
 * Called once lazily before the first VFS operation.
 * Uses a shared promise so concurrent callers all await the same bootstrap.
 */
function ensureDefaults(): Promise<void> {
  if (!_bootstrapPromise) {
    _bootstrapPromise = (async () => {
      for (const dir of DEFAULT_DIRS) {
        try {
          await pfs().mkdir(dir);
        } catch (e: any) {
          if (e.code !== 'EEXIST') throw e;
        }
      }
    })();
  }
  return _bootstrapPromise;
}

// ─── Helpers ───

/**
 * Normalize a virtual path: resolve `~` to `/home/user`, resolve `.` / `..`,
 * deduplicate slashes, strip trailing slash, ensure absolute.
 * Prevents path confusion from agent-generated inputs.
 */
export function normalizePath(p: string): string {
  // Resolve ~ and ~/ to /home/user
  if (p === '~') p = '/home/user';
  else if (p.startsWith('~/')) p = '/home/user/' + p.slice(2);
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

/** Encode each `/`-separated segment with `encodeURIComponent` so `/` stays as
 *  a separator. Useful for embedding a relative VFS path in a URL fragment. */
export function encodeRelPath(rel: string): string {
  return rel.split('/').map(encodeURIComponent).join('/');
}

/** Return the parent directory of a file path. */
function parentDir(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx <= 0 ? '/' : filePath.slice(0, idx);
}

// ─── Change event channel ───

/** Kind of VFS mutation surfaced to listeners. */
export type VfsChangeKind = 'write' | 'delete' | 'rename';

/** A successful VFS mutation. Emitted synchronously after the underlying
 *  IndexedDB write resolves. Modeled as a discriminated union so that
 *  narrowing on `kind` guarantees `oldPath` is present on `rename`. */
export type VfsChangeEvent =
  | { kind: 'write'; path: string }
  | { kind: 'delete'; path: string }
  | { kind: 'rename'; path: string; oldPath: string };

type VfsChangeListener = (event: VfsChangeEvent) => void;

const _listeners = new Set<VfsChangeListener>();

/** Notify all listeners in THIS context. Listener errors are logged via
 *  console.warn but never propagated — a buggy subscriber must not be
 *  able to fail the originating VFS operation. */
function emitLocal(event: VfsChangeEvent): void {
  for (const listener of _listeners) {
    try {
      listener(event);
    } catch (err) {
      console.warn('[vfs] listener threw on', event, err);
    }
  }
}

const MSG_TYPE = 'cebian:vfs:change' as const;

interface VfsBroadcastMessage {
  type: typeof MSG_TYPE;
  event: VfsChangeEvent;
}

/** Called by VFS mutations on success. Notifies local listeners, then
 *  broadcasts to other extension contexts via chrome.runtime.sendMessage.
 *
 *  We use chrome.runtime.sendMessage (not BroadcastChannel) because MV3
 *  service workers do not wake from BroadcastChannel messages — only
 *  chrome.runtime events can wake an idle SW. Without that wake-up, a UI
 *  write while the SW is asleep would leave the SW's in-memory caches
 *  stale until the next unrelated wake event. */
function emitChange(event: VfsChangeEvent): void {
  emitLocal(event);
  try {
    const msg: VfsBroadcastMessage = { type: MSG_TYPE, event };
    chrome.runtime.sendMessage(msg).catch(() => {
      // "Could not establish connection. Receiving end does not exist."
      // — normal when no UI pages are open and the sender is the SW.
      // Local listeners already ran above; nothing else to do.
    });
  } catch {
    // chrome.runtime may be unavailable in some test environments.
    // In-process notification (above) is still functional.
  }
}

// Bridge: receive cross-context broadcasts and re-emit them locally so
// the rest of this module looks single-context. Registered exactly once
// per realm — ES modules are evaluated at most once. In MV3 SW the
// listener registers during top-level boot, BEFORE Chrome dispatches
// any pending wake-up message, so no broadcast is lost.
try {
  chrome.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as Partial<VfsBroadcastMessage> | null;
    if (
      m?.type === MSG_TYPE &&
      m.event &&
      typeof m.event.kind === 'string' &&
      typeof m.event.path === 'string'
    ) {
      emitLocal(m.event);
    }
    return false; // We never reply; don't hold the channel open.
  });
} catch {
  /* in-process only fallback */
}

/** Subscribe to VFS mutations. The listener fires for changes that
 *  originate in this context AND for changes broadcast from other
 *  extension contexts. Returns an unsubscribe function.
 *
 *  Listeners must avoid writing back the same path they just received,
 *  or they will trigger an infinite feedback loop. If you need to react
 *  with a write, gate it so the listener does not re-fire on its own
 *  output. */
function onChange(listener: VfsChangeListener): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
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
  await ensureDefaults();
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
 *
 * Implementation detail: the recursive descent runs in `rmImpl` and does
 * NOT emit change events per leaf — the outer `rm` emits exactly once for
 * the top-level path on success. Subscribers that care about subtree
 * changes filter with `event.path.startsWith(deletedPath + '/')`.
 */
async function rmImpl(targetPath: string, opts?: RmOptions): Promise<void> {
  // targetPath is already normalized by the outer `rm` (and by parent
  // recursive calls), so we skip normalization and the bootstrap check
  // here — saves a few ops per leaf during recursive deletes.
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
      await rmImpl(childPath, { recursive: true, force });
    }
  }

  return pfs().rmdir(targetPath);
}

async function rm(targetPath: string, opts?: RmOptions): Promise<void> {
  await ensureDefaults();
  const normalized = normalizePath(targetPath);
  await rmImpl(normalized, opts);
  emitChange({ kind: 'delete', path: normalized });
}

/**
 * Check if a file/directory exists (like `fs.promises.access`).
 * Throws ENOENT if it doesn't exist.
 */
async function access(targetPath: string): Promise<void> {
  await ensureDefaults();
  await pfs().stat(normalizePath(targetPath));
}

/**
 * Check whether a path exists. Convenience wrapper over access().
 */
async function exists(targetPath: string): Promise<boolean> {
  await ensureDefaults();
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
  await ensureDefaults();
  filePath = normalizePath(filePath);
  const dir = parentDir(filePath);
  if (dir !== '/') {
    await mkdir(dir, { recursive: true });
  }
  await pfs().writeFile(filePath, data, opts as FS.WriteFileOptions);
  emitChange({ kind: 'write', path: filePath });
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
  await ensureDefaults();
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
  await ensureDefaults();
  src = normalizePath(src);
  dest = normalizePath(dest);
  const data = await pfs().readFile(src);
  await writeFile(dest, data as Uint8Array);
}

// ─── Public API (fs/promises-like) ───

// Typed wrappers instead of .bind() to preserve overload signatures
export const vfs = {
  async readFile(path: string, opts?: 'utf8' | { encoding?: 'utf8' }) {
    await ensureDefaults();
    return pfs().readFile(normalizePath(path), opts);
  },
  async readdir(path: string) {
    await ensureDefaults();
    return pfs().readdir(normalizePath(path));
  },
  async stat(path: string) {
    await ensureDefaults();
    return pfs().stat(normalizePath(path));
  },
  async lstat(path: string) {
    await ensureDefaults();
    return pfs().lstat(normalizePath(path));
  },
  async rename(oldPath: string, newPath: string) {
    await ensureDefaults();
    const oldNorm = normalizePath(oldPath);
    const newNorm = normalizePath(newPath);
    await pfs().rename(oldNorm, newNorm);
    emitChange({ kind: 'rename', path: newNorm, oldPath: oldNorm });
  },
  async symlink(target: string, path: string) {
    await ensureDefaults();
    return pfs().symlink(target, normalizePath(path));
  },
  async readlink(path: string) {
    await ensureDefaults();
    return pfs().readlink(normalizePath(path));
  },
  async unlink(path: string) {
    await ensureDefaults();
    const normalized = normalizePath(path);
    await pfs().unlink(normalized);
    emitChange({ kind: 'delete', path: normalized });
  },
  async rmdir(path: string) {
    await ensureDefaults();
    const normalized = normalizePath(path);
    await pfs().rmdir(normalized);
    emitChange({ kind: 'delete', path: normalized });
  },
  async du(path: string) {
    await ensureDefaults();
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
  onChange,
};

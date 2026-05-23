import { vfs } from '@/lib/vfs';
import picomatch from 'picomatch';

/** Maximum file content size (bytes) returned by fs_read_file before truncation. */
export const MAX_READ_SIZE = 100 * 1024; // 100 KB

/** Maximum number of results returned by fs_search. */
export const MAX_SEARCH_RESULTS = 50;

/**
 * Recursively walk a directory tree, yielding all file paths.
 * Skips entries that fail to stat (e.g. broken symlinks).
 */
export async function walkDir(dirPath: string, signal?: AbortSignal, maxDepth = 50): Promise<string[]> {
  if (maxDepth <= 0) return [];
  signal?.throwIfAborted();
  const results: string[] = [];
  const entries = await vfs.readdir(dirPath);
  for (const entry of entries) {
    signal?.throwIfAborted();
    const fullPath = dirPath === '/' ? `/${entry}` : `${dirPath}/${entry}`;
    try {
      const info = await vfs.stat(fullPath);
      if (info.isDirectory()) {
        const sub = await walkDir(fullPath, signal, maxDepth - 1);
        results.push(...sub);
      } else {
        results.push(fullPath);
      }
    } catch {
      // skip inaccessible entries
    }
  }
  return results;
}

/**
 * Test whether a file path matches a glob pattern.
 * Uses picomatch for full glob support (*, **, ?, {}, etc.).
 */
export function globMatch(pattern: string, filePath: string): boolean {
  return picomatch(pattern, { dot: true })(filePath);
}

/**
 * Format file size in human-readable form.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Check if content is likely binary by looking for null bytes in the first 8KB.
 */
export function isBinaryContent(data: Uint8Array): boolean {
  const checkLen = Math.min(data.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (data[i] === 0) return true;
  }
  return false;
}

import { zip } from 'fflate';
import { vfs } from '@/lib/vfs';

/** 递归遍历 VFS 中的 `rootPath`，把每个常规文件打进一个 zip 归档。归档内的
 *  路径相对 `rootPath` 扁平保留——下载 `/prompts` 得到的 `prompts.zip` 根条目
 *  就是 `foo.md`、`sub/bar.md`……（没有额外包一层文件夹），让归档镜像用户看到
 *  的 VFS 子树。
 *
 *  文件发现（含 symlink 跟随 / 循环防护、坏条目静默跳过）委托给 `vfs.walkFiles`。 */
export async function zipDirectory(rootPath: string): Promise<Uint8Array> {
  const files = await vfs.walkFiles(rootPath);
  const entries: Record<string, Uint8Array> = {};
  for (const { relPath, absPath } of files) {
    entries[relPath] = (await vfs.readFile(absPath)) as unknown as Uint8Array;
  }

  return new Promise((resolve, reject) => {
    zip(entries, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

/** Returns the filename to use when downloading `path` as a zip. Strips
 *  the trailing slash and uses the basename; root `/` falls back to a
 *  branded name so users don't end up with a nameless `.zip`. */
export function zipNameFor(path: string): string {
  if (path === '/') return 'cebian-vfs.zip';
  const base = path.split('/').filter(Boolean).pop() ?? 'cebian-vfs';
  return `${base}.zip`;
}

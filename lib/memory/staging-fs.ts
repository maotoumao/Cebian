// 记忆整理事务的 VFS 原语（IO 层；纯决策在 organize-plan.ts）。整理 manager 编排它们：
// 读指纹/内容（喂 plan 的比对/diff、validate 的校验）、清目录、把 staging 整体替换进
// live（提交）。live→staging 的复制直接用通用的 `vfs.copyDir`。
//
// 全部按 walkFiles 递归遍历并以 relPath 为键——这样整理 agent 万一在 staging 里留下
// 嵌套或非 .md 文件，也会带着含 `/` 的 relPath 出现在校验输入里被拒（守 top-level .md
// 不变量），不会被「只看顶层」悄悄漏过。

import { vfs } from '@/lib/persistence/vfs';
import type { MemoryManifest } from './organize-plan';

const decoder = new TextDecoder();

/** 读目录下全部常规文件的「relPath → mtime」指纹（提交时比对 live 是否被动过）。 */
export async function readDirManifest(dir: string): Promise<MemoryManifest> {
  const manifest: MemoryManifest = {};
  if (!(await vfs.exists(dir))) return manifest;
  for (const { relPath, absPath } of await vfs.walkFiles(dir)) {
    try {
      const st = await vfs.stat(absPath);
      manifest[relPath] = st.mtimeMs;
    } catch {
      // walk 与 stat 之间被并发删除 → 跳过该条，不让一个坏条目中断整次读取。
    }
  }
  return manifest;
}

/** 读目录下全部常规文件的「relPath → 全文」（喂 diff 与 validate）。 */
export async function readDirFiles(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (!(await vfs.exists(dir))) return out;
  for (const { relPath, absPath } of await vfs.walkFiles(dir)) {
    try {
      const raw = await vfs.readFile(absPath, 'utf8');
      out[relPath] = typeof raw === 'string' ? raw : decoder.decode(raw as Uint8Array);
    } catch {
      // 同上：竞态删除 / 读失败跳过。
    }
  }
  return out;
}

/** 递归删除目录（含其本身）；不存在也不报错。 */
export async function removeDir(dir: string): Promise<void> {
  await vfs.rm(dir, { recursive: true, force: true });
}

/**
 * 用 staging 内容整体替换 live：清空 live 再把 staging 全量复制过去。**幂等**——重复执行
 * 结果一致，故崩溃后可安全重做（恢复路径 redoCommit 依赖此性质）。
 *
 * 预检：先把 staging 的文件清单 walk 出来；staging 缺失 / 不可读则**先抛错、不碰 live**
 * （否则会把 live 清空后才发现没源可拷，造成数据丢失）。
 */
export async function replaceLiveWithStaging(staging: string, live: string): Promise<void> {
  if (!(await vfs.exists(staging))) {
    throw new Error(`staging dir missing, refusing to replace live: ${staging}`);
  }
  const entries = await vfs.walkFiles(staging);
  // walk 失败会在动 live 之前抛出（预检）。
  await vfs.rm(live, { recursive: true, force: true });
  await vfs.mkdir(live, { recursive: true });
  for (const { relPath } of entries) {
    await vfs.copyFile(`${staging}/${relPath}`, `${live}/${relPath}`);
  }
}

// VFS（lightning-fs 虚拟文件系统）这个备份「源」的采集 / 恢复编排。
//
// VFS 装技能、提示词、工作区文件。它在扩展页面同源可直接读写，不经 background。
// 本源不认识「技能 / 工作区」这些分类概念，只认识路径前缀（roots）——分类到 roots
// 的映射由顶层 collect / restore 编排持有，和 storage registry 解耦同理。
//
// 文件在 bundle 里的 key 形如 `vfs/<去前导斜杠的绝对路径>`，例如 VFS 里的
// `/home/user/.cebian/skills/foo/SKILL.md` → `vfs/home/user/.cebian/skills/foo/SKILL.md`。
// 这层 `vfs/` 前缀是 VFS 在 payload 内的命名空间；archive 打包时还会再套一层
// `payload/`。

import { vfs, normalizePath, isProtectedVfsRoot } from '@/lib/vfs';
import {
  vfsPathToKey,
  vfsKeyToPath,
  isVfsKey,
  isUnderAnyRoot,
} from '../payload-format';
import type { RestoreStrategy } from '../types';

/** VFS 文件的 mtime 索引：key（含 `vfs/` 前缀）→ 采集时的源 mtimeMs。随 payload
 *  一起保存（明文 payload 内），供恢复时做 path + mtime 的 last-write-wins。 */
export type VfsIndex = Record<string, number>;

/** 采集结果：VFS 文件（key 带 `vfs/` 前缀）+ 对应 mtime 索引。 */
export interface CollectedVfs {
  files: Record<string, Uint8Array>;
  index: VfsIndex;
}

/** 逐分类恢复结果，供 UI 反馈。 */
export interface VfsRestoreResult {
  /** 实际写入的文件数。 */
  written: number;
  /** 跳过的文件数（merge 的 LWW / 同名目录，以及任一模式下的受保护根条目）。 */
  skipped: number;
  /** replace 模式下被清空内容的 root 数（清内容、保留目录节点；非文件数）。 */
  cleared: number;
}

// ─── 写入决策（纯逻辑） ───
//
// VFS 是 IndexedDB 支撑的，不便在单测里跑；故把「该写哪些 / 跳过哪些 / 清空哪些
// root」的决策抽成不碰 IO 的纯函数（与会话源 planSessionWrites 同一思路），由
// restoreVfs 收集本地 mtime / 目录信息后调用并执行。

/** VFS 恢复的写入计划（key 含 `vfs/` 前缀；clearRoots 为待清空「内容」的绝对 root，
 *  执行层只清内容、保留目录节点）。 */
export interface VfsWritePlan {
  toWrite: string[];
  toSkip: string[];
  clearRoots: string[];
}

/**
 * 规划 VFS 恢复要做的写入。仅考虑落在 `targetRoots`（已规范化的绝对路径）前缀下的备份
 * 文件，并守两条「结构红线」：
 *
 * - **受保护根不可写**：任何路径正好等于某个受保护根（`isProtectedVfsRoot`，如
 *   `/workspaces`、技能 / 提示词根、VFS 根）的条目，两种模式都跳过——它们是「容器」，
 *   永远不能被当作文件写入。挡住构造 / 损坏包把目录写成文件。
 * - **本地同名目录不可覆写**：merge 下若某备份文件的目标路径在本地恰好是个目录
 *   （`localDirs` 含此绝对路径），跳过——`writeFile` 往目录路径写会抛错、且不该删用户
 *   的目录。replace 不需此项：根已整体清空，同名目录此刻已不存在。
 *
 * - `replace`：`clearRoots` = 全部 targetRoots（执行层清空其内容、保留节点），`toWrite`
 *   = 这些根下、且未触红线的全部备份文件。
 * - `merge`：本地缺失（`localMtimes` 无此 key）或备份更新（`backupMtimes` > 本地 mtime）
 *   → 写入，否则跳过。绝不删除本地多出来的文件。
 */
export function planVfsWrites(
  backupKeys: string[],
  backupMtimes: VfsIndex,
  localMtimes: Record<string, number>,
  localDirs: Set<string>,
  targetRoots: string[],
  strategy: RestoreStrategy,
): VfsWritePlan {
  const candidateKeys = backupKeys.filter(
    (key) => isVfsKey(key) && isUnderAnyRoot(vfsKeyToPath(key), targetRoots),
  );

  const toWrite: string[] = [];
  const toSkip: string[] = [];
  for (const key of candidateKeys) {
    const absPath = vfsKeyToPath(key);
    // 红线 1：受保护根本身永不可作为文件写入（两种模式）。
    if (isProtectedVfsRoot(absPath)) {
      toSkip.push(key);
      continue;
    }
    // 红线 2：本地同名目录，merge 不覆写（replace 已清空根，无需此判断）。
    if (strategy === 'merge' && localDirs.has(absPath)) {
      toSkip.push(key);
      continue;
    }
    if (strategy === 'replace') {
      toWrite.push(key);
      continue;
    }
    // merge：path + mtime last-write-wins。
    const localMtime = localMtimes[key];
    const backupMtime = backupMtimes[key];
    let shouldWrite: boolean;
    if (localMtime === undefined) {
      // 本地缺失 → 补入。
      shouldWrite = true;
    } else if (backupMtime === undefined) {
      // 本地已有、但备份没有可比的 mtime（异常 / 损坏包）→ 不敢覆盖更新的本地，跳过。
      shouldWrite = false;
    } else {
      // 本地与备份都有 mtime → 备份更新才覆盖。
      shouldWrite = backupMtime > localMtime;
    }
    if (shouldWrite) toWrite.push(key);
    else toSkip.push(key);
  }

  return {
    toWrite,
    toSkip,
    clearRoots: strategy === 'replace' ? [...targetRoots] : [],
  };
}

// ─── 源的公开 API（供顶层 collect / restore 编排调用） ───

/**
 * 采集给定 roots 下的全部常规文件及其 mtime。roots 应为绝对 VFS 路径（顶层据用户
 * 勾选的分类传入，如技能 / 提示词目录、`/workspaces`）。不存在的 root 静默跳过。
 */
export async function collectVfs(roots: string[]): Promise<CollectedVfs> {
  const files: Record<string, Uint8Array> = {};
  const index: VfsIndex = {};

  for (const rawRoot of roots) {
    const root = normalizePath(rawRoot);
    if (!(await vfs.exists(root))) continue;

    const entries = await vfs.walkFiles(root);
    for (const { absPath } of entries) {
      try {
        const bytes = (await vfs.readFile(absPath)) as unknown as Uint8Array;
        const st = await vfs.stat(absPath);
        const key = vfsPathToKey(absPath);
        files[key] = bytes;
        index[key] = st.mtimeMs;
      } catch {
        // 单个文件在 walk 与 read/stat 之间被并发删除 / 出错 → 跳过该文件，不让一个
        // 坏条目中断整次采集（与 vfs.walkFiles 跳过坏条目同理）。
      }
    }
  }

  return { files, index };
}

/**
 * 把采集到的 VFS 文件按策略写回。只处理 key 落在 `targetRoots` 前缀下的文件（顶层据
 * 用户勾选的分类传入要恢复的根）。决策由 `planVfsWrites` 给出，本函数负责收集本地
 * mtime 并执行计划。
 *
 * 已知限制：VFS 是多写者（页面 / agent / skill 都能写）。本函数不加锁，恢复期间若
 * 有并发写同一文件，可能发生竞态。恢复是用户在设置里主动发起的破坏性操作，由 UI
 * 层提示恢复期间不要同时进行对话 / 文件编辑；这与会话恢复的处理一致。
 */
export async function restoreVfs(
  files: Record<string, Uint8Array>,
  backupMtimes: VfsIndex,
  targetRoots: string[],
  strategy: RestoreStrategy,
): Promise<VfsRestoreResult> {
  const normRoots = targetRoots.map(normalizePath);
  const targetKeys = Object.keys(files).filter(
    (key) => isVfsKey(key) && isUnderAnyRoot(vfsKeyToPath(key), normRoots),
  );

  // 收集这些目标路径的本地状态：mtime（merge 比较用）+ 哪些在本地是目录（红线 2：
  // merge 不把文件写到本地目录路径上，否则 writeFile 抛错且会损坏目录）。
  const localMtimes: Record<string, number> = {};
  const localDirs = new Set<string>();
  for (const key of targetKeys) {
    const absPath = vfsKeyToPath(key);
    if (!(await vfs.exists(absPath))) continue;
    const st = await vfs.stat(absPath);
    if (st.isDirectory()) localDirs.add(absPath);
    else localMtimes[key] = st.mtimeMs;
  }

  const plan = planVfsWrites(Object.keys(files), backupMtimes, localMtimes, localDirs, normRoots, strategy);

  let cleared = 0;
  for (const root of plan.clearRoots) {
    if (await clearDirContents(root)) cleared++;
  }
  for (const key of plan.toWrite) {
    await vfs.writeFile(vfsKeyToPath(key), files[key]);
  }

  return { written: plan.toWrite.length, skipped: plan.toSkip.length, cleared };
}

/** 清空一个目录的「内容」、保留目录节点本身（受保护根恒为目录，见 PROTECTED_VFS_ROOTS）。
 *  逐个删子项而非 rm 整个根。VFS 根 `/` 永不在此操作（守卫）。返回是否清了内容。 */
async function clearDirContents(root: string): Promise<boolean> {
  const norm = normalizePath(root);
  // VFS 根永不清空——它不是任何分类的合法清空目标，仅作兜底守卫。
  if (norm === '/') return false;
  if (!(await vfs.exists(norm))) return false;
  const names = await vfs.readdir(norm);
  for (const name of names) {
    await vfs.rm(`${norm}/${name}`, { recursive: true, force: true });
  }
  return true;
}

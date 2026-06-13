// 备份 payload 的布局：payload 文件名 + 分类到 VFS roots 的映射。
//
// 这是 collect / restore 两个顶层编排共用的单一事实源——「哪个分类对应 VFS 里哪些
// 根目录」「各分类数据写进 payload 里的哪个文件」都在此声明，避免两端各写一份漂移。
// VFS 源（sources/vfs.ts）只认路径前缀、不认分类，分类知识收敛在这里。

import { normalizePath } from '@/lib/vfs';
import { CEBIAN_SKILLS_DIR, CEBIAN_PROMPTS_DIR, WORKSPACES_ROOT } from '@/lib/constants';
import { isValidSessionId } from '@/lib/utils';

/** payload 内各分类数据的文件名（裸路径，archive 会再套 `payload/` 前缀）。 */
export const PAYLOAD_FILES = {
  /** 普通设置（无密钥）。 */
  config: 'config.json',
  /** 密钥信息。 */
  credentials: 'credentials.json',
  /** VFS 文件的 mtime 索引。 */
  vfsIndex: 'vfs-index.json',
} as const;

/** 会话目录前缀（payload 内，裸路径）。每个会话单独存为 `sessions/{id}.json`，
 *  避免单个大 `sessions.json` 在会话多 / 长对话时膨胀并被整体 parse。 */
export const SESSIONS_DIR = 'sessions/';

/** 单个会话在 payload 里的文件 key（`sessions/{id}.json`）。 */
export function sessionFileKey(id: string): string {
  return `${SESSIONS_DIR}${id}.json`;
}

/** 若 key 是一个合法的会话文件（`sessions/{uuid}.json`，恰好一段、id 是 UUID），
 *  返回其会话 id；否则返回 null。比单纯前缀判断更严，挡住 `sessions/foo/bar.json`、
 *  `sessions/index.json` 等非会话条目。 */
export function sessionIdFromFileKey(key: string): string | null {
  if (!key.startsWith(SESSIONS_DIR) || !key.endsWith('.json')) return null;
  const stem = key.slice(SESSIONS_DIR.length, -'.json'.length);
  if (stem.includes('/')) return null;
  return isValidSessionId(stem) ? stem : null;
}

/** 「技能与提示词」分类对应的 VFS 绝对根目录。normalizePath 是纯函数，可在模块
 *  加载期求值。 */
export const SKILLS_PROMPTS_ROOTS = [
  normalizePath(CEBIAN_SKILLS_DIR),
  normalizePath(CEBIAN_PROMPTS_DIR),
];

/** 某个会话的工作区目录。采集工作区时按已备份会话 id 过滤，避免把已删会话残留的
 *  孤儿工作区也打进备份。 */
export function workspaceRootForSession(sessionId: string): string {
  return `${WORKSPACES_ROOT}/${sessionId}`;
}

// ─── VFS 在 bundle 里的命名空间映射（collect / restore / vfs 源共用） ───

/** bundle 内 VFS 文件 key 的前缀。 */
export const VFS_PREFIX = 'vfs/';

/** 把绝对 VFS 路径转成 bundle key（`/home/...` → `vfs/home/...`）。 */
export function vfsPathToKey(absPath: string): string {
  return VFS_PREFIX + absPath.replace(/^\//, '');
}

/** 把 bundle key 转回绝对 VFS 路径（`vfs/home/...` → `/home/...`）。 */
export function vfsKeyToPath(key: string): string {
  return '/' + key.slice(VFS_PREFIX.length);
}

/** 判断一个 bundle key 是否属于 VFS 命名空间（带 `vfs/` 前缀）。payload 里还有
 *  config.json / sessions/{uuid}.json 等非 VFS 文件，必须先过滤掉，否则 vfsKeyToPath 盲目
 *  slice 会把诸如 `xxxworkspaces/a.txt` 误映射成 `/workspaces/a.txt`。 */
export function isVfsKey(key: string): boolean {
  return key.startsWith(VFS_PREFIX);
}

/** 判断绝对路径是否落在某个 root 前缀下（root 自身或其子孙）。 */
export function isUnderRoot(absPath: string, root: string): boolean {
  return absPath === root || absPath.startsWith(root + '/');
}

/** 判断绝对路径是否落在任一给定 root 下。 */
export function isUnderAnyRoot(absPath: string, roots: string[]): boolean {
  return roots.some((r) => isUnderRoot(absPath, r));
}

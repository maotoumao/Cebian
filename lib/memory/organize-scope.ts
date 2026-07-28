// 整理 agent 的「作用域锁」纯逻辑——把它的所有 fs 操作限制在 staging 副本目录内。
// beforeToolCall gate（entrypoints/background/memory/organize-agent.ts）用这两个纯函数做判断；
// 抽到 lib 便于单测安全边界（../ 逃逸、相邻同名前缀、rename 双路径）。

import { normalizePath } from '@/lib/persistence/vfs';
import { TOOL_FS_RENAME } from '@/lib/tools/names';

/**
 * 路径是否落在 staging 根之内（含根本身）。两端都 normalizePath，故 `../` 逃逸会被
 * 解析掉、相邻同名前缀目录（如 `<root>-bak`）不会误命中。
 */
export function isWithinStaging(rawPath: string, stagingRoot: string): boolean {
  const p = normalizePath(rawPath);
  const root = normalizePath(stagingRoot);
  return p === root || p.startsWith(root + '/');
}

/**
 * 从一次 fs 工具调用的参数里取出全部「路径」参数。fs_rename 有 old_path + new_path
 * 两个，其余 fs 工具是单个 path。gate 用它逐个查作用域——漏查任一路径都是越权口子。
 */
export function organizePathArgs(toolName: string, args: Record<string, unknown>): string[] {
  if (toolName === TOOL_FS_RENAME) {
    return [args.old_path, args.new_path].filter((p): p is string => typeof p === 'string');
  }
  return typeof args.path === 'string' ? [args.path] : [];
}

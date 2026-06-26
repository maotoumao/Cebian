/**
 * Shared VFS proxy whitelist + scoped-path enforcement for skill scripts.
 *
 * 类比 `chrome-api-whitelist.ts`：单一事实来源，决定 skill 通过 sandbox 的
 * `vfs` 全局可以调哪些方法、对哪些路径生效。
 *
 * 设计要点：
 * - 权限拆为 `vfs.read` / `vfs.write` 两档，分别覆盖纯读 / 含写操作方法
 * - 作用域**绑定到当前 session 的 workspace**：`/workspaces/<sessionId>/<skill>/`。
 *   这样产物跟 agent 自己写入 workspace 的文件共存于同一棵子树下，session
 *   删除时 `background/index.ts` 已有的 `vfs.rm({recursive:true})` 顺带清理，
 *   markdown 链接形如 `#/workspaces/<sessionId>/<skill>/cat.png` 也直接命中
 *   `MarkdownRenderer.resolveVfsHref` 的 Case 1，零额外渲染逻辑。
 * - 跨 session 持久状态**不在 v1 范围**，需要时另起 `vfs.cache` 之类的权限。
 */

import { normalizePath } from '@/lib/persistence/vfs';
import { isValidSessionId } from '@/lib/utils';
import { parsePermission } from './permissions';

// ─── Method groups (white-list) ───

/** Read-only VFS methods — granted by `vfs.read`. */
export const VFS_READ_METHODS = new Set([
  'readFile', 'readdir', 'stat', 'exists',
]);

/** Mutating VFS methods — granted by `vfs.write`. */
export const VFS_WRITE_METHODS = new Set([
  'writeFile', 'mkdir', 'unlink',
]);

// ─── Path security helpers ───

/** Prototype-pollution guard for method names and skill segments. */
const FORBIDDEN_PARTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Validate a skill folder name for the purpose of **path construction**.
 *
 * 这条校验只是「构造 `/workspaces/<sessionId>/<skill>` 时不会被打穿」的安全底线，
 * **不是** agentskills 规范的形状校验。规范层面的命名（小写、连字符、长度上限等）由 scanner /
 * skill-creator 引导用户遵守。如果在这一层加入规范层校验，会导致 scanner 已加载、能跑
 * 其它权限的 skill 仅在声明 `vfs.*` 时炸掉 —— 同类的“silent cliff”。
 *
 * 拒绝项（全部是路径构造安全项）：
 * - 空串、非字符串
 * - `.` / `..` （会打穿路径作用域）
 * - 包含 `/` `\` 或控制字符（会裂变成多段路径）
 * - prototype-pollution 关键字
 *
 * 长度上限、大小写、前导点 .hidden 、unicode 名字 —— 都不是这一层的职责。
 */
export function isValidSkillName(skill: string): boolean {
  if (!skill || typeof skill !== 'string') return false;
  if (FORBIDDEN_PARTS.has(skill)) return false;
  if (skill === '.' || skill === '..') return false;
  // 任何路径分隔符 / 控制字符都不允许 —— 一旦放行就会破坏 normalizePath 的不变量。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\/\\]/.test(skill)) return false;
  return true;
}

/**
 * Compute the per-session, per-skill VFS root.
 *
 * 形如 `/workspaces/<sessionId>/<skill>`（无尾斜杠）。skill 脚本相对该路径
 * 写入文件，落地到 session 的 workspace 子目录下，跟 agent 自己产生的
 * 文件共存。
 */
export function sessionSkillRoot(sessionId: string, skill: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid sessionId for vfs scope: ${sessionId}`);
  }
  if (!isValidSkillName(skill)) {
    throw new Error(`Invalid skill name for vfs scope: ${skill}`);
  }
  return normalizePath(`/workspaces/${sessionId}/${skill}`);
}

/**
 * Check whether a vfs method call is allowed for the given permission set.
 * Blocks prototype pollution attempts (`__proto__`, `constructor`, ...) and
 * enforces flat method names (no dots).
 *
 * 权限语义：
 * - `vfs.read` 单独存在：仅允许读类方法（readFile / readdir / stat / exists）
 * - `vfs.write` 存在：允许全部方法，**自动包含读类**。
 *   理由：skill 已经能在自己的 `.data/` 子目录里任意写文件，再禁止它读
 *   自己刚写的东西没有意义，只会逼用户两条权限都写一遍。作用域本身已经
 *   是隐私边界，读写细分在 scope 内部没有保护价值。
 */
export function isVfsCallAllowed(method: string, permissions: string[]): boolean {
  if (typeof method !== 'string') return false;
  if (FORBIDDEN_PARTS.has(method)) return false;
  if (method.includes('.')) return false;
  // 认 token 统一走沙箱能力词汇（lib/tools/permissions），不在这里重复比字符串。
  const hasWrite = permissions.some((p) => parsePermission(p)?.kind === 'vfsWrite');
  const hasRead = hasWrite || permissions.some((p) => parsePermission(p)?.kind === 'vfsRead');
  if (VFS_READ_METHODS.has(method)) return hasRead;
  if (VFS_WRITE_METHODS.has(method)) return hasWrite;
  return false;
}

/**
 * Resolve a skill-supplied relative path to an absolute VFS path, asserting
 * it stays under the given `root`. Throws on:
 *   - non-string input
 *   - absolute paths (`/...`) or `~`-prefixed paths
 *   - paths that, after normalization (`..` resolution), escape the root
 *
 * **允许** `''` / `'.'` / `'./'` 这种归一到 root 本身的输入 —— 对 `readdir`
 * / `stat` 这种目录方法来说，根目录是天然的合法目标；`readFile('.')` /
 * `writeFile('')` 等明显不合理的用法交给底层 VFS 报 EISDIR 之类的明确错误，
 * 不在这一层包办。这一层只负责**安全**（防越界）。
 *
 * skill 调用方写 `'cat.png'` 或 `'subdir/cat.png'`，落地路径会是
 * `<root>/cat.png` 或 `<root>/subdir/cat.png`。
 */
export function resolveScopedPath(rel: unknown, root: string): string {
  if (typeof rel !== 'string') {
    throw new Error('vfs path must be a string');
  }
  // 拒绝绝对路径 / ~ 起手 —— skill 只能传相对路径。
  if (rel.startsWith('/') || rel === '~' || rel.startsWith('~/') || rel.startsWith('~\\')) {
    throw new Error(`vfs path must be relative to skill workspace, got: ${rel}`);
  }
  const candidate = normalizePath(`${root}/${rel}`);
  // candidate === root 是合法情况（如 readdir('.')）；只拦实际越界。
  if (candidate !== root && !candidate.startsWith(root + '/')) {
    throw new Error(`vfs path escapes skill workspace: ${rel}`);
  }
  return candidate;
}

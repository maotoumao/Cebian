// 沙箱能力词汇（sandbox capability vocabulary）。
//
// 权限 token 的本质是「沙箱在执行时被授予的能力」——每个 token 对应沙箱里
// 一个实打实的能力开关（暴露 `vfs` / `bgFetch` / chrome 代理 / `executeInPage`）。
// 这层是**全代码库唯一**做权限字符串匹配的地方：所有 `=== 'vfs.read'` /
// `startsWith('chrome.')` / `startsWith('bgFetch:')` 都收敛到 `parsePermission`。
//
// 词汇与「谁触发」无关——今天唯一的生产者是 skill 的 `metadata.permissions`，
// 但未来给 `chrome_api` 等工具加执行前授权时可复用同一套 token，因此命名不带
// `skill`。能力的「派生」（构造沙箱 global / 计算 vfsRoot）是沙箱专属逻辑，留在
// `sandbox-rpc.ts` / `sandbox/main.ts`，不进本模块。
//
// 公共 API 见文件末尾。

import { CHROME_API_WHITELIST } from './chrome-api-whitelist';
import { assertNever } from '@/lib/utils';

// ─── 判别联合 ───

/**
 * 一条权限 token 解析后的结构化形态。`parsePermission` 是唯一构造点。
 * - `chrome` 的 `namespace` 保持 string：本层只判**形状**，「该 namespace
 *   是否在白名单」是 `isPermissionAllowed` / 运行时校验的职责，两者解耦。
 * - `bgFetch` 的 `pattern` 省略表示 bare `bgFetch`（任意 http(s) URL）。
 */
type Permission =
  | { kind: 'pageExecuteJs' }
  | { kind: 'vfsRead' }
  | { kind: 'vfsWrite' }
  | { kind: 'bgFetch'; pattern?: string }
  | { kind: 'chrome'; namespace: string };

// chrome.<ns> token 的形状校验：ns 必须以字母起手、仅含字母数字。
const CHROME_TOKEN_RE = /^chrome\.([a-zA-Z][a-zA-Z0-9]*)$/;

/**
 * 把单个原始 token 解析成 `Permission`。形状不合法（未知 token、`bgFetch:`
 * 空 pattern 等 malformed 输入）返回 `null`，由调用方决定如何处理（描述层
 * 原样回显、校验层判为不允许）。
 *
 * 注意：本函数**不**校验 chrome namespace 是否在白名单内——`chrome.foo` 只要
 * 形状合法就解析成 `{ kind: 'chrome', namespace: 'foo' }`。有效性查 `isPermissionAllowed`。
 */
function parsePermission(raw: string): Permission | null {
  if (raw === 'page.executeJs') return { kind: 'pageExecuteJs' };
  if (raw === 'vfs.read') return { kind: 'vfsRead' };
  if (raw === 'vfs.write') return { kind: 'vfsWrite' };

  if (raw === 'bgFetch') return { kind: 'bgFetch' };
  if (raw.startsWith('bgFetch:')) {
    const pattern = raw.slice('bgFetch:'.length);
    // 空 pattern（`bgFetch:`）是 malformed —— 落到 null 而非伪装成 bare bgFetch。
    if (pattern) return { kind: 'bgFetch', pattern };
    return null;
  }

  const chromeMatch = CHROME_TOKEN_RE.exec(raw);
  if (chromeMatch) return { kind: 'chrome', namespace: chromeMatch[1] };

  return null;
}

// ─── 校验 ───

/**
 * 判断一条 token 是否为运行时允许的权限。固定 token（page.executeJs / vfs.* /
 * bgFetch[:pattern]）只要形状合法即允许；`chrome.<ns>` 还需 `<ns>` 落在
 * `CHROME_API_WHITELIST`（唯一真值源）。
 *
 * hasOwnProperty 守卫：避免把继承名（`chrome.constructor` / `chrome.toString`）
 * 误判为合法权限。
 */
function isPermissionAllowed(raw: string): boolean {
  const perm = parsePermission(raw);
  if (!perm) return false;
  if (perm.kind === 'chrome') {
    return Object.prototype.hasOwnProperty.call(CHROME_API_WHITELIST, perm.namespace);
  }
  return true;
}

// ─── 分类 ───

/**
 * 权限的安全属性：能运行代码或读取用户状态的归 `sensitive`（UI 据此渲染
 * destructive badge，与沙箱运行时的对待方式对齐）。`page.executeJs` 与任意
 * `chrome.<ns>` 都属敏感；vfs.* / bgFetch 作用域受限，归 `normal`。
 *
 * 未知 token（parse 为 null）保守归 `normal`——它本就不会被授予能力。
 * switch 用穷尽检查（assertNever）：将来新增一种 kind 必须在此显式决定
 * 敏感与否，漏掉则编译失败，不会静默落到 `normal`。
 */
function classifyPermission(raw: string): 'sensitive' | 'normal' {
  const perm = parsePermission(raw);
  if (!perm) return 'normal';
  switch (perm.kind) {
    case 'pageExecuteJs':
    case 'chrome':
      return 'sensitive';
    case 'vfsRead':
    case 'vfsWrite':
    case 'bgFetch':
      return 'normal';
    default:
      return assertNever(perm);
  }
}

// ─── Public API ───

export type { Permission };
export { parsePermission, isPermissionAllowed, classifyPermission };

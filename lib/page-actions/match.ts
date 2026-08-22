// 页面 URL 匹配：页面交互 UI（悬浮球 / 划词工具条）与单个划词动作的生效范围判定。
//
// 纯模块（无 chrome / DOM 依赖），内容脚本可直接引——注意 depcruise 禁止
// `*.content/` 引 `lib/browser/`，所以匹配逻辑必须留在这里而不是 tab-actions。
//
// 语法沿用仓库唯一的 URL 匹配实现 `lib/tools/url-pattern`（Chrome match-pattern，
// 与 bgFetch 权限同一套），不引入第二种 glob 方言。注意它只匹配 pathname，
// query / fragment 不参与——设置 UI 的 hint 需要如实说明。

import { parseMatchPattern, matchUrl } from '@/lib/tools/url-pattern';

/**
 * 校验单条 pattern。合法返回 null，非法返回错误消息（供设置 UI 逐条即时提示）。
 * `parseMatchPattern` 以抛错表达非法，这里把它收成返回值，因为「用户正在输入」
 * 是预期内状态、不是异常。
 */
export function validatePagePattern(input: string): string | null {
  try {
    parseMatchPattern(input);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * url 是否命中 patterns 中任意一条。
 *
 * - 空列表 → false（「没有规则」= 不限制，由调用方决定这代表全部显示还是全部隐藏）
 * - 坏 pattern 跳过并 warn：设置里存着的历史脏数据不该让整个工具条罢工
 * - url 本身不可解析（如空串）→ false
 */
export function matchesAnyPagePattern(url: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  for (const raw of patterns) {
    let pattern;
    try {
      pattern = parseMatchPattern(raw);
    } catch (err) {
      console.warn('[cebian] skipping invalid page pattern:', raw, (err as Error).message);
      continue;
    }
    if (matchUrl(parsed, pattern)) return true;
  }
  return false;
}

// ─── 页面生效范围 ───

/**
 * 一处 UI / 动作的页面生效范围。悬浮球、划词工具条、每个划词动作共用同一套语义与
 * 同一个编辑器组件。
 *
 * 刻意做成两个方向而不是「统一成黑名单或白名单」：两种需求都真实存在但落在不同层级
 * ——工具条通常想「在某几个站点别弹」，动作通常想「只在某个站点出现」。单极统一必然
 * 逼出「列举全世界其它站点」这种做不到的配置。
 */
export interface PageScope {
  /** 仅在这些页面生效；空 = 所有页面。 */
  include: string[];
  /** 在这些页面不生效。优先于 include，故「只在 A 生效但排除 A 下某路径」也表达得出。 */
  exclude: string[];
}

/**
 * 补齐缺省，得到规范的范围（两个列表都在）。读配置的唯一入口。
 *
 * 兼容读取一种旧形状：范围曾经是一个裸的 pattern 数组，语义是「仅在这些页面」，故按
 * include 解析。那个形状只存在于未发布的开发版本，这段兼容为的是不让开发期配过的规则
 * 静默失效。它只作用于**读**路径——备份采集 / 恢复原样读写值，未编辑过的数据会一直是
 * 旧形状，所以除非哪天真写一次持久化迁移，这段不能删。
 */
export function resolvePageScope(
  scope: Partial<PageScope> | readonly string[] | undefined,
): PageScope {
  if (Array.isArray(scope)) return { include: [...scope], exclude: [] };
  const s = scope as Partial<PageScope> | undefined;
  return { include: [...(s?.include ?? [])], exclude: [...(s?.exclude ?? [])] };
}

/** 范围是否没做任何限制（两个列表都空）——供 UI 决定要不要打「限定页面」标记。 */
export function isUnrestrictedPageScope(scope: PageScope): boolean {
  return scope.include.length === 0 && scope.exclude.length === 0;
}

/** 当前 url 是否落在生效范围内。exclude 先扣除，再看 include（空 include = 全部）。 */
export function matchesPageScope(url: string, scope: PageScope): boolean {
  if (matchesAnyPagePattern(url, scope.exclude)) return false;
  if (scope.include.length === 0) return true;
  return matchesAnyPagePattern(url, scope.include);
}

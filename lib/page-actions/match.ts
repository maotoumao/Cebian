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

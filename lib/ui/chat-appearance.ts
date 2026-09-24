// 对话区外观 → CSS 变量的换算（渲染边界）。
//
// 只产出两个局部 CSS 变量，由侧边栏根节点（及设置页预览）挂上，对话组件经
// assets/tailwind.css 里的 `chat-text-*` / `chat-font` 工具类消费：
// - `--chat-text-scale`：字号倍率。消费方写成 `calc(<原始 rem> * var(--chat-text-scale, 1))`，
//   没挂变量的上下文（如 VFS 预览复用 MarkdownRenderer）按 1 渲染、保持原样。
// - `--chat-font-family`：字体栈。默认预设写成 `initial`（无效值），消费方回退 `inherit`——
//   必须显式写而不是省略：省略时会从外层继承（如设置页预览嵌在侧边栏根节点里，会拿到已保存的字体）。

import type { CSSProperties } from 'react';
import type { ChatAppearance } from '@/lib/persistence/storage';

/** 衬线预设：优先系统衬线，再给中文宋体 / 思源宋体兜底，避免中文落回无衬线。 */
const SERIF_STACK =
  "ui-serif, Georgia, 'Songti SC', 'Noto Serif CJK SC', 'Source Han Serif SC', SimSun, serif";

/**
 * 把任意字符串编码成 CSS 字符串字面量（双引号包裹）。
 * 反斜杠与引号转义；控制字符（含换行）直接丢弃——字体名里不会有，留着只会让声明失效
 * （未转义换行会截断字符串，尾部反斜杠会吃掉闭引号）。
 */
function toCssString(value: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '');
  return `"${cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 预设 → font-family 值；默认预设（或自定义名为空）返回 undefined，表示不覆盖界面字体。 */
function chatFontFamily(appearance: ChatAppearance): string | undefined {
  switch (appearance.fontPreset) {
    case 'default':
      return undefined;
    case 'serif':
      return SERIF_STACK;
    case 'mono':
      return 'var(--font-mono)';
    case 'custom':
      // 找不到该字体时浏览器按列表往后回退到界面默认字体
      return appearance.customFontName
        ? `${toCssString(appearance.customFontName)}, var(--font-sans)`
        : undefined;
  }
}

/** 对话区外观 → 挂在容器上的 style（CSS 变量）。入参应已经过 resolveChatAppearance。 */
function chatAppearanceStyle(appearance: ChatAppearance): CSSProperties {
  return {
    '--chat-text-scale': String(appearance.fontScalePercent / 100),
    '--chat-font-family': chatFontFamily(appearance) ?? 'initial',
  } as CSSProperties;
}

export { chatAppearanceStyle, toCssString };

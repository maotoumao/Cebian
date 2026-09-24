// Local Font Access API（Chromium 103+ 桌面版）的最小封装：设置页的字体选择器与授权页共用。
// TS 的 DOM 类型尚未收录该 API，这里只声明用到的部分。

/** queryLocalFonts 返回的单个字形（每个字重 / 样式一条）。 */
interface LocalFontData {
  family: string;
}

type QueryLocalFonts = () => Promise<LocalFontData[]>;

/** 取当前浏览器的 queryLocalFonts；不支持时返回 undefined。 */
function getQueryLocalFonts(): QueryLocalFonts | undefined {
  const fn = (window as { queryLocalFonts?: QueryLocalFonts }).queryLocalFonts;
  return typeof fn === 'function' ? fn.bind(window) : undefined;
}

/** 当前浏览器能否列出本机字体；不能则设置页不提供「自定义」字体。 */
function isLocalFontAccessSupported(): boolean {
  return getQueryLocalFonts() !== undefined;
}

export type { QueryLocalFonts };
export { getQueryLocalFonts, isLocalFontAccessSupported };

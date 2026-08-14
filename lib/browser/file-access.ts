/**
 * 本地文件访问权限（chrome://extensions 详情页的「允许访问文件网址」开关）。
 *
 * 扩展无法替用户打开这个开关，只能检测 + 引导：工具层在操作 file:// 目标前
 * 调用 assertFileAccess 做前置检查，未开启时抛出带确切设置页地址的定向错误，
 * 由 LLM 用用户的语言转告；聊天渲染层（MarkdownRenderer）对该精确地址做了
 * 点击接管（chrome:// 链接无法从页面内容直接导航，只能经 chrome.tabs.create）。
 */

/** 本扩展详情页地址 —— 「允许访问文件网址」开关所在的页面 */
function extensionSettingsUrl(): string {
  return `chrome://extensions/?id=${chrome.runtime.id}`;
}

function isFileUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'file:';
  } catch {
    return false;
  }
}

/**
 * file:// 目标的前置权限检查（background 工具层调用）。开关未开时抛出面向
 * LLM 的定向错误；已开启则放行——之后若仍失败，让真实的 fetch/注入错误
 * 自然浮出，便于诊断
 */
async function assertFileAccess(url: string): Promise<void> {
  if (!isFileUrl(url)) return;
  if (await chrome.extension.isAllowedFileSchemeAccess()) return;
  throw new Error(
    'Cannot read local file:// pages: the user has not enabled "Allow access to file URLs" ' +
    'for this extension. Tell the user, in their language and with the toggle name translated ' +
    `to match their browser locale, to open ${extensionSettingsUrl()} — include this exact ` +
    'chrome:// URL as a markdown link in your reply; it is clickable in the chat — turn on ' +
    'the "Allow access to file URLs" toggle on that page, and then ask you to retry.',
  );
}

export { assertFileAccess, extensionSettingsUrl };

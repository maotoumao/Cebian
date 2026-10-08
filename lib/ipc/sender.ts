// runtime 消息的来源判定（background 侧消息监听器使用）。
//
// 不能用 `sender.tab` 区分「扩展自身页面」与「内容脚本」：以标签页打开的扩展页面
// （如在新标签页打开的设置中心）发消息时 `sender.tab` 同样非空。可靠的判据是
// `sender.url`——内容脚本的 url 是所在网页的地址，扩展页面的 url 落在本扩展的 origin 下。

/**
 * 消息是否来自本扩展自身的页面（侧边栏、以标签页打开的扩展页面、离屏文档等）。
 * 内容脚本、其它扩展、缺少 url 的来源一律返回 false。
 */
function isExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  // getURL('') 以 `/` 结尾，`chrome-extension://<id>evil/...` 这类前缀伪造不会命中
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(''));
}

export { isExtensionPageSender };

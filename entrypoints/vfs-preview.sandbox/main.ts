/**
 * VFS HTML 预览的沙箱代理页——外层 iframe。
 *
 * 为什么需要它：扩展页（vfs.html）的 CSP 是 `script-src 'self'`，srcdoc / blob iframe 都会
 * 继承这条策略，AI 生成的 HTML 里的内联 `<script>` 和 CDN 脚本全部会被拦。本页通过 WXT 的
 * `*.sandbox/` 约定进入 manifest `sandbox.pages`，拥有不透明 origin 与放宽的 sandbox CSP
 * （见 wxt.config.ts），拿不到 `chrome.*` 与扩展存储；用户文件在这里的内层 iframe 中渲染。
 *
 * 与 `mcp-app.sandbox` 的双层 iframe 模式相同，但协议只有两条消息、不做 JSON-RPC 透传：
 *   1. 本页加载完成 → 向宿主发 `{ type: 'vfs-preview-ready' }`；
 *   2. 宿主回 `{ type: 'vfs-preview-render', html }` → 本页创建 / 替换内层 srcdoc iframe。
 * 只接受 `event.source === window.parent` 的消息；内层 iframe 发来的任何消息都不转发。
 */

interface RenderMessage {
  type: 'vfs-preview-render';
  html: string;
}

/** 内层 iframe 的 sandbox 令牌固定不变（与 mcp-app.sandbox 同一组合）。
 *  注意 `allow-same-origin` 在这里并不能放宽任何东西：sandbox 标志沿 frame 树只能收紧——
 *  本页自身已被 manifest 的 sandbox CSP 与宿主 iframe 的 sandbox 属性剥掉 origin，所以内层
 *  拿到的是它自己的一个全新不透明 origin，`localStorage` / `document.cookie` 等存储 API 会抛
 *  SecurityError。保留该令牌只是为了与既有沙箱页保持同一形状。
 *  不给 `allow-top-navigation`，预览内容不能劫持整个标签页；`allow-popups` 不带
 *  `-to-escape-sandbox`，弹出的窗口继承同样的沙箱限制。 */
const INNER_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-modals allow-popups';

let inner: HTMLIFrameElement | null = null;

function render(html: string): void {
  // 每次渲染都换一个新 iframe：srcdoc 重新赋值在部分浏览器上不会重置内层脚本状态。
  inner?.remove();
  inner = document.createElement('iframe');
  inner.setAttribute('sandbox', INNER_SANDBOX);
  inner.srcdoc = html;
  document.body.appendChild(inner);
}

function isRenderMessage(data: unknown): data is RenderMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as RenderMessage).type === 'vfs-preview-render' &&
    typeof (data as RenderMessage).html === 'string'
  );
}

window.addEventListener('message', (event: MessageEvent) => {
  // 不透明 origin 下 event.origin 恒为 'null'，无法用于鉴权；event.source 是不可伪造的窗口引用。
  if (event.source !== window.parent) return;
  if (isRenderMessage(event.data)) render(event.data.html);
});

// targetOrigin 只能用 '*'：本页拿不到 chrome.runtime，不知道宿主的 chrome-extension:// origin。
// 宿主侧会校验 event.source 是它自己创建的 iframe，这条 ready 通知本身不携带任何数据。
window.parent.postMessage({ type: 'vfs-preview-ready' }, '*');

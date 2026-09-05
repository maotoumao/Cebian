import { useLayoutEffect, useRef } from 'react';
import { supportsHtmlPreviewScripts } from '../../lib/preview-capabilities';

/** 沙箱代理页地址（`entrypoints/vfs-preview.sandbox/` → manifest `sandbox.pages`）。 */
const SANDBOX_URL = browser.runtime.getURL('/vfs-preview.html' as never);

/** 宿主 iframe 的 sandbox 令牌：不给 `allow-same-origin`，这样即使在不支持 manifest sandbox
 *  的浏览器里加载了代理页，它也拿不到扩展 origin。 */
const HOST_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups';

/** HTML 预览：填满主区域。
 *
 *  Chromium 下走双层 iframe——本组件只持有外层沙箱代理页，代理页加载后发 ready，本组件
 *  收到即把 HTML postMessage 过去，由代理页创建内层 srcdoc iframe（见 vfs-preview.sandbox/main.ts）。
 *  App 在每次导航时都会经过 loading 态，所以换文件必然重新挂载本组件、代理页整页重载；
 *  `html` 变化时重发只是为同槽位复用留的口子。
 *
 *  握手可靠性的两个要点：
 *   1. 监听器先装、再给 iframe 赋 `src`。iframe 一旦带 src 提交就开始加载，代理页只发一次
 *      ready；若监听器在 passive effect 里才装，本地扩展页足够快时可能永久错过。
 *   2. 每次收到 ready 都重发当前 HTML，而不是记一个只能从 false 变 true 的布尔：代理页
 *      自发重载后会再发一次 ready，这时也要重新投喂。
 *
 *  Firefox 不支持 manifest `sandbox.pages`，代理页会以扩展 origin 运行、脚本又被扩展页 CSP
 *  拦掉——干脆不走代理，直接用一个无脚本的 srcdoc iframe 做静态渲染。 */
function HtmlPreview({ html, title }: { html: string; title: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const htmlRef = useRef(html);
  const readyRef = useRef(false);
  htmlRef.current = html;

  useLayoutEffect(() => {
    if (!supportsHtmlPreviewScripts) return;
    const frame = frameRef.current;
    if (!frame) return;
    const send = () => {
      // targetOrigin 只能是 '*'：沙箱页 origin 不透明，没有可指定的值；收件方是我们自己创建的窗口。
      frame.contentWindow?.postMessage({ type: 'vfs-preview-render', html: htmlRef.current }, '*');
    };
    const onMessage = (event: MessageEvent) => {
      // 只认自己那个 iframe 发来的消息；不透明 origin 下 event.origin 是 'null'，不能用于鉴权。
      if (event.source !== frame.contentWindow) return;
      if ((event.data as { type?: unknown } | null)?.type === 'vfs-preview-ready') {
        readyRef.current = true;
        send();
      }
    };
    window.addEventListener('message', onMessage);
    // 监听器已就位，现在才开始加载代理页。
    frame.src = SANDBOX_URL;
    return () => {
      window.removeEventListener('message', onMessage);
      readyRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (!supportsHtmlPreviewScripts || !readyRef.current) return;
    frameRef.current?.contentWindow?.postMessage({ type: 'vfs-preview-render', html }, '*');
  }, [html]);

  const className = 'absolute inset-0 w-full h-full border-0 bg-white';
  if (!supportsHtmlPreviewScripts) {
    return <iframe title={title} sandbox="" srcDoc={html} className={className} />;
  }
  return <iframe ref={frameRef} title={title} sandbox={HOST_SANDBOX} className={className} />;
}

export { HtmlPreview };

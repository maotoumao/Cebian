// 页面交互内容脚本：在所有页面注入一个 Shadow DOM 隔离的 React 根，承载悬浮球、
// 划词工具条与内联结果卡。用 WXT createShadowRootUi 保证样式与页面主题互不侵入。

import ReactDOM from 'react-dom/client';
import { PageActionsApp } from './App';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {
      name: 'cebian-page-actions',
      position: 'inline',
      anchor: 'body',
      // host 充满视口但 pointer-events:none，只有内部交互元素（悬浮球 / 工具条）
      // 自己置 pointer-events:auto。这样既不阻挡页面交互，又能稳定命中自己的
      // 子元素——0x0 host 会让溢出到它盒外的固定子元素在 Chrome 里点不到（能画出、收不到事件）。
      css: ':host { position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important; margin: 0 !important; pointer-events: none !important; z-index: 2147483647 !important; } @keyframes cebian-spin { to { transform: rotate(360deg); } }',
      onMount(container) {
        const root = ReactDOM.createRoot(container);
        root.render(<PageActionsApp />);
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });
    ui.mount();
  },
});

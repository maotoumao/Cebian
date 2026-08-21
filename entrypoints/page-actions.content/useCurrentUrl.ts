import { useEffect, useState } from 'react';

/** Navigation API（Chrome 102+ / Firefox 147+）的可选形态；没有它时退回 popstate/hashchange。 */
type NavigationLike = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * 当前页面 URL，跟随站内导航更新。
 *
 * 内容脚本挂载一次就长期存活，SPA 站点内跳转（history.pushState）不会重挂组件，所以
 * 「按页面隐藏」的判定必须自己盯着 URL 变化，否则决定会停在进入页面那一刻的地址上。
 *
 * 用 Navigation API 的 `currententrychange`——它在**可见 URL 提交后**立即触发，覆盖
 * pushState / replaceState / 前进后退 / hash 跳转。刻意不用 `navigatesuccess`：SPA 用
 * `NavigateEvent.intercept()` 时它要等异步 handler 跑完才触发，handler 慢或失败会让隐藏
 * 判定滞留在旧 URL 上。
 *
 * 没有 Navigation API 时（Firefox 147 以下）退回 popstate / hashchange，此时纯 pushState
 * 跳转会漏：内容脚本在隔离世界，看不到页面侧对 history.pushState 的调用，无法靠打补丁
 * 感知；漏掉的情形会在下一次前进 / 后退或刷新时自动纠正。这里不做轮询——为一个纯展示
 * 决策持续跑定时器不值得。
 */
export function useCurrentUrl(): string {
  const [url, setUrl] = useState(() => location.href);

  useEffect(() => {
    const sync = () => setUrl(location.href);
    const navigation = (window as unknown as { navigation?: NavigationLike }).navigation;
    if (navigation) {
      navigation.addEventListener('currententrychange', sync);
    } else {
      window.addEventListener('popstate', sync);
      window.addEventListener('hashchange', sync);
    }
    // 首帧与 effect 注册之间可能已经跳过一次，补一次同步。
    sync();
    return () => {
      if (navigation) {
        navigation.removeEventListener('currententrychange', sync);
      } else {
        window.removeEventListener('popstate', sync);
        window.removeEventListener('hashchange', sync);
      }
    };
  }, []);

  return url;
}

// 录制器里的网络采集：按浏览器选用 CDP（Chrome）或 webRequest（Firefox）。
//
// 录制器在「开始跟踪某个标签页 / 标签页跳转 / 标签页关闭」时通知这里，结束时取回整理好的
// NetworkLog。两种实现共用 network-log 的过滤、上限与打码规则。

import { isDebuggerAvailable } from '@/lib/browser/debugger-session';
import type { NetworkCaptureState, NetworkLog } from '@/lib/recorder/network-types';
import { CdpNetworkCapture } from './cdp-network';
import { WebRequestNetworkCapture } from './webrequest-network';

interface NetworkCapture {
  /** 已录到的请求数。 */
  readonly count: number;
  readonly state: NetworkCaptureState;
  /** 录制器开始跟踪这个标签页（重复调用无副作用）。`url` 是标签页当前地址，普通网页才连接。 */
  observe(tabId: number, url: string | undefined): void;
  /** 被跟踪的标签页开始跳转（必要时重新连接）。 */
  tabNavigated(tabId: number, url: string | undefined): void;
  tabClosed(tabId: number): void;
  /** 结束录制网络，返回整理好的记录；只调用一次。 */
  stop(): Promise<NetworkLog>;
}

/** `onChange`：请求数或状态变化时调用，供录制器刷新状态广播。 */
function startNetworkCapture(startedAt: number, onChange: () => void): NetworkCapture {
  return isDebuggerAvailable()
    ? new CdpNetworkCapture(startedAt, onChange)
    : new WebRequestNetworkCapture(startedAt, onChange);
}

// ─── 公开 API ───

export { startNetworkCapture, type NetworkCapture };

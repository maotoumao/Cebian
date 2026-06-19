// 各类权限的「请求器」—— 纯逻辑，无 React、无 DOM 组件依赖。
//
// 一个请求器负责：触发浏览器的运行时授权弹窗，并把结果归一化成
// `RequestOutcome`。新增权限类型（摄像头 / 通知等）时，在此目录加一个
// `<type>.ts` 文件并登记到下方 `REQUESTERS`，再补对应 i18n 文案与面板即可。

import { requestMicrophone } from './microphone';

/** 一次授权请求的归一化结果。
 *  - granted：已授权
 *  - dismissed：弹窗被关闭但未选择（可重试）
 *  - denied：被明确阻止（需去浏览器设置手动放开）
 *  - deviceError：设备缺失 / 无法访问 */
export type RequestOutcome = 'granted' | 'dismissed' | 'denied' | 'deviceError';

/** 把某类权限的请求封装成「触发浏览器授权 → 归一化结果」。 */
export type PermissionRequester = () => Promise<RequestOutcome>;

/** 已支持的权限类型 → 请求器。新增权限在此登记。
 *  用 Partial 让索引结果带 `undefined`，强制调用方处理未知类型。 */
export const REQUESTERS: Partial<Record<string, PermissionRequester>> = {
  microphone: requestMicrophone,
};

/** 按 type 取请求器，限定自有键，避免 `constructor` / `__proto__` 等原型链键
 *  被 URL 当成已支持类型。未知类型返回 undefined。 */
export function getRequester(type: string): PermissionRequester | undefined {
  return Object.hasOwn(REQUESTERS, type) ? REQUESTERS[type] : undefined;
}

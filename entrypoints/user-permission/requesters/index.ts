// 各类权限的「请求器」—— 纯逻辑，无 React、无 DOM 组件依赖。
//
// 一个请求器负责：触发浏览器的运行时授权弹窗，并把结果归一化成
// `RequestOutcome`。新增权限类型（摄像头 / 通知等）时：先在 `lib/ui/user-permission.ts`
// 的 `PermissionType` 里加上它（连带权限名与设置页地址），再在此目录加一个 `<type>.ts`
// 登记到下方 `REQUESTERS`，并在 `panels/configs.tsx` 补图标与文案——三处都按
// `PermissionType` 穷举，漏了哪处都编译不过。

import type { PermissionType } from '@/lib/ui/user-permission';
import { requestLocalFonts } from './local-fonts';
import { requestMicrophone } from './microphone';

/** 一次授权请求的归一化结果。
 *  - granted：已授权
 *  - dismissed：弹窗被关闭但未选择（可重试）
 *  - denied：被明确阻止（需去浏览器设置手动放开）
 *  - deviceError：设备缺失 / 无法访问（本机字体：读取本身出错） */
export type RequestOutcome = 'granted' | 'dismissed' | 'denied' | 'deviceError';

/** 把某类权限的请求封装成「触发浏览器授权 → 归一化结果」。 */
export type PermissionRequester = () => Promise<RequestOutcome>;

/** 已支持的权限类型 → 请求器。新增权限在此登记。 */
export const REQUESTERS: Record<PermissionType, PermissionRequester> = {
  microphone: requestMicrophone,
  'local-fonts': requestLocalFonts,
};

/** 把 URL 里的 `?type=` 收窄成已支持的权限类型，限定自有键，避免 `constructor` /
 *  `__proto__` 等原型链键被当成已支持类型。未知类型返回 undefined。 */
export function parsePermissionType(type: string): PermissionType | undefined {
  return Object.hasOwn(REQUESTERS, type) ? (type as PermissionType) : undefined;
}

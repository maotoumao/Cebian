import { getQueryLocalFonts } from '@/lib/ui/local-fonts';
import { queryPermission } from '@/lib/ui/user-permission';
import type { PermissionRequester, RequestOutcome } from './index';

/** 调用后的权限状态 → 归一化结果。prompt / 查不到状态都按可重试处理。 */
async function outcomeFromPermission(): Promise<RequestOutcome> {
  const state = await queryPermission('local-fonts');
  return state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'dismissed';
}

/**
 * 本机字体：调用 queryLocalFonts 触发授权（本页由按钮点击调用，带 transient activation）。
 * Chromium 在拒绝 / 关闭弹窗时既可能 reject NotAllowedError，也可能直接 resolve 空数组，
 * 所以两种情况都以调用后的权限状态为准来区分「已阻止」和「可重试」。
 * 读取本身出错（非权限原因）归为 deviceError，面板按「读取失败」展示。
 */
export const requestLocalFonts: PermissionRequester = async () => {
  const query = getQueryLocalFonts();
  if (!query) return 'deviceError';
  try {
    const fonts = await query();
    return fonts.length > 0 ? 'granted' : outcomeFromPermission();
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return outcomeFromPermission();
    return 'deviceError';
  }
};

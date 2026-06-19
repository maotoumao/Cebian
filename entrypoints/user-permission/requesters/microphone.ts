import type { PermissionRequester } from './index';

/** 麦克风：用 getUserMedia 触发授权，拿到后立即释放音轨（识别会另开）。 */
export const requestMicrophone: PermissionRequester = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return 'granted';
  } catch (err) {
    const e = err as DOMException;
    if (e.name === 'NotAllowedError') {
      // Chrome 在「关闭弹窗未选择」时 message 为 "Permission dismissed"，
      // 在「点了阻止」时为 "Permission denied"。据此区分可重试 vs 需去设置。
      return /dismiss/i.test(e.message) ? 'dismissed' : 'denied';
    }
    // NotFoundError / NotReadableError / OverconstrainedError 等：设备问题。
    return 'deviceError';
  }
};

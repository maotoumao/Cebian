import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { CLIENT_PORT, type ClientMessage, type ServerMessage } from '@/lib/ipc/protocol';
import { t } from '@/lib/i18n';

/** 按整理结果弹 toast——空转 / 冲突 / 失败都给明确反馈，避免「点一下闪一下」没动静。
 *  失败时把后台报的原因当 description 带上，便于诊断（如网络波动）。 */
function toastOutcome(
  outcome: NonNullable<(ServerMessage & { type: 'memory_organize_state' })['outcome']>,
  error?: string,
): void {
  switch (outcome) {
    case 'ok':
      toast.success(t('settings.memory.organize.toast.ok'));
      break;
    case 'empty':
      toast.info(t('settings.memory.organize.toast.empty'));
      break;
    case 'conflict':
      toast.info(t('settings.memory.organize.toast.conflict'));
      break;
    case 'no-model':
      toast.error(t('settings.memory.organize.toast.noModel'));
      break;
    case 'rejected':
    case 'failed':
      toast.error(t('settings.memory.organize.toast.failed'), error ? { description: error } : undefined);
      break;
  }
}

/**
 * 手动触发跨对话记忆整理，并跟踪运行态。
 *
 * 整理是全局后台任务：本 hook 在挂载期间保持一个端口连接，监听后台广播的
 * `memory_organize_state`（running / error）。结果详情（diff/摘要/上次时间）不走此通道，
 * 由调用方用 useStorageItem 响应式读取 memoryOrganizeState。
 */
export function useMemoryOrganize(onOrganized?: () => void): {
  running: boolean;
  error: string | null;
  trigger: () => void;
} {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  // 回调放 ref，避免它的身份变化触发 effect 重连端口。
  const onOrganizedRef = useRef(onOrganized);
  onOrganizedRef.current = onOrganized;

  useEffect(() => {
    const port = chrome.runtime.connect({ name: CLIENT_PORT });
    portRef.current = port;
    const onMessage = (msg: ServerMessage) => {
      if (msg.type !== 'memory_organize_state') return;
      setRunning(msg.running);
      if (msg.error) setError(msg.error);
      else if (msg.running) setError(null);
      // 运行结束（running=false）且携 outcome → toast 反馈。
      if (!msg.running && msg.outcome) {
        toastOutcome(msg.outcome, msg.error);
        // 仅 'ok'（已提交、文件确实变了）时通知刷新文件列表。
        if (msg.outcome === 'ok') onOrganizedRef.current?.();
      }
    };
    const onDisconnect = () => {
      // 端口断开（后台重启 / SW 挂起）→ 收不到 running:false 广播了，避免卡在「整理中」。
      portRef.current = null;
      setRunning(false);
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    // 挂载时查一次当前运行态：切 tab 再切回时，若后台仍在整理则恢复「整理中」。
    port.postMessage({ type: 'memory_organize_query' } satisfies ClientMessage);
    return () => {
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      try {
        port.disconnect();
      } catch {
        /* already disconnected */
      }
      portRef.current = null;
    };
  }, []);

  const trigger = useCallback(() => {
    const port = portRef.current;
    if (!port) {
      setError('disconnected');
      return;
    }
    setError(null);
    try {
      port.postMessage({ type: 'memory_organize' } satisfies ClientMessage);
      setRunning(true); // 发送成功才乐观置位；后台广播会校正
    } catch {
      // 端口刚断、postMessage 抛错 → 不置 running，避免卡死。
      portRef.current = null;
      setError('disconnected');
    }
  }, []);

  return { running, error, trigger };
}

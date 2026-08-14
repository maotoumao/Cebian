// recorder 域面向 UI 端口的接线：状态广播、连接首帧、成品投递、断连丢弃。
// 面向内容脚本的另一半（注入钩子 / 事件监听 / 抑制）在 `content-bridge.ts`。
//
// recorder 是全局、按实例归属的概念（不按会话路由），所以状态走 `broadcastAll`
// 而非 chat 的 viewer 定向投递。

import { recorder } from './manager';
import { onPortConnect, onPortDisconnect, post, broadcastAll } from '../ipc/port-registry';
import type { ServerMessage } from '@/lib/ipc/protocol';

/** 把 recorder 当前状态拍成 `recorder_status` 消息（广播与连接首帧共用）。 */
function recorderStatusMessage(): ServerMessage {
  const status = recorder.getStatus();
  return {
    type: 'recorder_status',
    isRecording: status.isRecording,
    startedAt: status.startedAt,
    eventCount: status.eventCount,
    truncated: status.truncated,
    initiatorInstanceId: status.initiatorInstanceId,
    activeWindowId: status.activeWindowId,
  };
}

/**
 * 注册 UI 端口侧的全部 recorder 接线。在 `index.ts` 启动序列里、
 * `setupPortRegistry()` 之前同步调用。
 */
function setupRecorderPortRelay(): void {
  // Send recorder_status to every connected port (recorder is a global,
  // per-instance concept, not session-scoped).
  recorder.onStatusChange(() => broadcastAll(recorderStatusMessage()));

  // Forward finalized recordings to whichever port owned the recording.
  // Both manual `stop()` and the cap-trigger `autoStop()` fan out through
  // this single hook, so we never need to special-case auto-stop on the
  // delivery side. We snapshot the initiator port BEFORE recorder.stop()
  // clears it; by the time this fires, recorder state is already idle, so
  // we capture the port via a closure on the start path instead.
  let lastInitiatorPort: chrome.runtime.Port | null = null;
  recorder.onStatusChange(() => {
    // Track the current initiator while it exists so the session listener
    // (which fires AFTER recorder clears it) still knows where to send.
    const ip = recorder.getInitiatorPort();
    if (ip) lastInitiatorPort = ip;
  });
  recorder.onRecordingFinished(session => {
    const target = lastInitiatorPort;
    lastInitiatorPort = null;
    if (!target) {
      console.warn('[recorder] session finalized but no initiator port to deliver to');
      return;
    }
    try {
      // 故意不走 port-registry 的 post（尽力而为投递）——丢掉一份已完成的录制
      // 值得打一条 warn，而不是静默吞掉。
      target.postMessage({
        type: 'recorder_session',
        session,
      } satisfies ServerMessage);
    } catch (err) {
      // Port disconnected between recorder clear and our send. The session
      // is lost — acceptable, the user closed the surface.
      console.warn('[recorder] failed to deliver session:', err);
    }
  });

  onPortConnect((port) => {
    // Sync recorder state to the new port. Without this, a sidepanel that
    // opens during an active recording (or reconnects after a brief SW
    // suspension) would display "idle" until the next event triggers a
    // broadcast.
    post(port, recorderStatusMessage());
  });

  onPortDisconnect((port) => {
    // Recording is owned by a single sidepanel/tab instance (identified
    // by its port). When that exact port disconnects — sidepanel closed,
    // standalone tab closed — drop the in-flight recording immediately.
    // The recorder's keep-alive prevents SW suspension from triggering
    // a false-positive disconnect, so this branch only fires on a real
    // user action. Also drains any pending auto-stopped session so it
    // doesn't leak.
    if (recorder.getInitiatorPort() === port) {
      void recorder.stop({ discard: true })
        .catch(err => console.warn('[recorder] discard-on-disconnect failed:', err));
    }
  });
}

// ─── 公开 API ───

export { setupRecorderPortRelay };

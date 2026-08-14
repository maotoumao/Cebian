// recorder 域的客户端消息 handler：录制的启动与停止，含所有权门禁 ——
// 录制归属发起它的那个 UI 实例（经 `hello` 声明的 instanceId + 其端口），
// 别的实例不能停掉它，也不能在它进行中抢着开新录制。

import { recorder } from './manager';
import { registerClientHandlers, type ClientHandlerMap } from '../ipc/client-router';
import { getPortState, post } from '../ipc/port-registry';

const recorderClientHandlers: ClientHandlerMap = {
  async recorder_start(port) {
    const instanceId = getPortState(port)?.instanceId;
    if (instanceId == null) {
      // Sidepanel never sent its instanceId — reject so we never start
      // a recording we couldn't gate stop() on later.
      post(port, {
        type: 'recorder_start_rejected',
        reason: 'before_hello',
      });
      return;
    }
    const currentOwner = recorder.getInitiatorPort();
    if (currentOwner != null && currentOwner !== port) {
      // Another instance already owns the recording. Tell the
      // requesting client so it can toast "another window is
      // recording" instead of silently doing nothing.
      post(port, {
        type: 'recorder_start_rejected',
        reason: 'busy',
      });
      return;
    }
    // Resolve the requesting port's window so the recording starts
    // focused on the right tab. Prefer the last-focused normal window;
    // fall back to any normal window if the desktop currently has
    // focus (WINDOW_ID_NONE / unknown). This await yields, so we MUST
    // re-check ownership afterwards in case a concurrent recorder_start
    // from another port commits first.
    let initialWindowId: number = chrome.windows.WINDOW_ID_NONE;
    try {
      const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      if (focused.id != null) initialWindowId = focused.id;
    } catch { /* ignore — will try getAll below */ }
    if (initialWindowId === chrome.windows.WINDOW_ID_NONE) {
      try {
        const all = await chrome.windows.getAll({ windowTypes: ['normal'] });
        const first = all.find(w => w.id != null);
        if (first?.id != null) initialWindowId = first.id;
      } catch { /* leave as WINDOW_ID_NONE */ }
    }
    // Re-check ownership: another port may have grabbed the recorder
    // while we were awaiting window resolution. Without this, both
    // ports' pre-await guards pass, only one wins inside recorder.start
    // (which silently re-broadcasts), and the loser's UI gets no
    // rejection toast.
    const ownerNow = recorder.getInitiatorPort();
    if (ownerNow != null && ownerNow !== port) {
      post(port, {
        type: 'recorder_start_rejected',
        reason: 'busy',
      });
      return;
    }
    await recorder.start({ port, instanceId, initialWindowId });
  },

  async recorder_stop(port) {
    if (recorder.getInitiatorPort() !== port) {
      // Only the initiator instance's port may stop. Ignore from
      // other instances so a stale UI can't kill a sibling's recording.
      return;
    }
    // Don't send `recorder_session` from here — the `onRecordingFinished`
    // listener (index.ts 的 recorder 接线，子任务 8 再下沉) does that uniformly
    // for manual stop and cap-trigger auto-stop alike.
    await recorder.stop({ discard: false });
  },
};

/** 注册 recorder 域 handler。在 `index.ts` 启动序列里、`setupPortRegistry()` 之前同步调用。 */
function setupRecorderClientHandlers(): void {
  registerClientHandlers(recorderClientHandlers);
}

// ─── 公开 API ───

export { setupRecorderClientHandlers, recorderClientHandlers };

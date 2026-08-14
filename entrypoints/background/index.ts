import { setupOAuthRefresh } from './providers/oauth-refresh';
import { sessionManager } from './chat/session-manager';
import { setupChatClientHandlers } from './chat/client-handlers';
import { recoverOrganizeOnStartup, setupOrganizeSchedule } from './memory/organize-manager';
import { setupMemoryClientHandlers } from './memory/client-handlers';
import { recorder } from './recorder/manager';
import { setupRecorderClientHandlers } from './recorder/client-handlers';
import { setupRecorderPortRelay } from './recorder/port-relay';
import { setupMcpBridge } from './mcp/bridge';
import { seedDevStorage } from './providers/dev-seed';
import { registerBackupHandler } from './chat/backup-handler';
import { setupPageActions } from '@/lib/page-actions/manager';
import { runPageActionStream, materializeHandoff } from './page-actions/runner';
import { SUPPRESS_KIND } from '@/lib/page-actions/types';
import { isRecorderRuntimeMessage, RECORDER_MSG_KIND, type RecorderControlMessage } from '@/lib/recorder/protocol';
import { isInjectablePage } from '@/lib/browser/tab-actions';
import { setupUpdateNotice } from './lifecycle/update-notice';
import { setupPortRegistry } from './ipc/port-registry';
import { setupClientRouter } from './ipc/client-router';

export default defineBackground(() => {
  console.log('Cebian background started', { id: browser.runtime.id });

  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));

  setupOAuthRefresh();

  // 扩展升级后记下新版本号，供侧边栏下次打开时弹出更新日志。
  setupUpdateNotice();

  // 注册备份 IPC 响应器（会话采集 / 写回；Dexie 唯一写者经此转发）。
  registerBackupHandler();

  // 注册页面交互（悬浮球 / 划词工具条）的 runtime 消息处理器。
  setupPageActions({
    runStream: runPageActionStream,
    materializeHandoff,
    onContentPresent: handleContentPresent,
  });

  // 启动崩溃恢复：清理上次未收尾的整理。尽早触发；runOrganize 会 await 同一记忆化 promise，
  // 故整理流程不会与恢复重叠。其余记忆读取不强制等待它（崩溃恢复罕见、且 redoCommit 幂等）。
  void recoverOrganizeOnStartup().catch((err) =>
    console.warn('[organize] startup recovery failed:', err),
  );
  // 自动整理调度：注册周期 alarm（检查廉价，满足够久/够多/空闲才真跑）。
  setupOrganizeSchedule();
  // 订阅 MCP 服务端变更，把刷新后的工具集推给所有活跃会话。
  sessionManager.watchMCPTools();

  // Dev-only: seed a custom provider from .env.local if configured.
  // No-op in production builds and when WXT_DEV_API_KEY is empty.
  void seedDevStorage().catch(err => console.warn('[dev-seed] failed:', err));

  // ─── Port management ───
  //
  // 连接表、投递与连接生命周期在 `ipc/port-registry.ts`（纯传输）；消息分发在
  // `ipc/client-router.ts`（注册制查表）；「哪个窗口正在看哪个会话」与 grace-cancel
  // 在 chat 域（`chat/viewers.ts` / `chat/client-handlers.ts`）；recorder 的 UI 端口
  // 接线在 `recorder/port-relay.ts`。这里只剩下 recorder 面向内容脚本的接线
  // （注入钩子 / 事件监听 / 抑制 —— 子任务 8 Task 2 再下沉）。

  // 录制进行中时抑制被观察 tab 的页面交互 UI（悬浮球 / 工具条），避免误点击与录制噪声。
  // （取词 picker 由内容脚本自行观察 DOM，不走这里。）
  let suppressedRecorderTab: number | null = null;
  /** 把抑制目标切到 `tabId`（null = 无）：先给旧 tab 发 off，再给新 tab 发 on。 */
  function setRecorderSuppress(tabId: number | null): void {
    if (suppressedRecorderTab === tabId) return;
    if (suppressedRecorderTab != null) {
      void chrome.tabs
        .sendMessage(suppressedRecorderTab, { kind: SUPPRESS_KIND, on: false })
        .catch(() => {});
    }
    suppressedRecorderTab = tabId;
    if (tabId != null) {
      void chrome.tabs.sendMessage(tabId, { kind: SUPPRESS_KIND, on: true }).catch(() => {});
    }
  }
  recorder.onStatusChange(() => {
    const isRecording = recorder.getStatus().isRecording;
    const tabId = recorder.getObservedTabId();
    setRecorderSuppress(isRecording && typeof tabId === 'number' ? tabId : null);
  });
  /** 内容脚本挂载回报：若该 tab 正在被录制，把 on 重推一次（应对录制中途导航）。 */
  function handleContentPresent(tabId: number): void {
    if (recorder.getStatus().isRecording && tabId === recorder.getObservedTabId()) {
      void chrome.tabs.sendMessage(tabId, { kind: SUPPRESS_KIND, on: true }).catch(() => {});
    }
  }

  // ─── Recorder attach/detach hooks ───
  //
  // The recorder singleton is content-script-agnostic; this is where the
  // background wires the actual injection. `attach`:
  //   1. Skips restricted pages (chrome://, web store, etc.) silently —
  //      tab/navigation events still reach the timeline via the recorder's
  //      own chrome.tabs listeners; only interactions/mutations are missed.
  //   2. Programmatically injects the WXT-built content script bundle.
  //   3. Sends an `init` message carrying `startedAt` (so `t` is computed
  //      against a single clock) and `tabId` (content scripts can't
  //      discover their own tab id).
  //
  // `detach`:
  //   1. Sends `final_flush` so any pending mutation buffer is drained.
  //   2. Calls the script's `__cebianRecorderStop()` global to remove all
  //      listeners, the MutationObserver, and the global itself.
  //   3. Both messages are best-effort — if the script is gone (page
  //      navigated, tab closed) we swallow the error.
  recorder.setAttachHooks({
    async attach(tabId, startedAt) {
      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        return; // tab vanished between activated event and attach
      }
      if (!isInjectablePage(tab.url)) {
        // Restricted page (chrome://, web store, view-source:, file://, etc.).
        // Throw so the recorder marks the attach as failed and will retry
        // on the next `complete` navigation if the user moves to a normal page.
        throw new Error(`page not injectable: ${tab.url ?? '<no url>'}`);
      }
      // executeScript can fail if the page navigates between our tab.get
      // and this call, or if the page CSP blocks ISOLATED-world scripts.
      // Re-thrown errors land in the recorder's switchObservedTab catch
      // which marks attach failed and retries on the next `complete`.
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        files: ['/content-scripts/recorder.js'],
        world: 'ISOLATED',
      });
      // Send init. If the script is somehow gone already, swallow — the
      // recorder will see no events and the user will notice; better than
      // throwing and triggering an immediate retry storm.
      try {
        await chrome.tabs.sendMessage(tabId, {
          kind: RECORDER_MSG_KIND,
          type: 'init',
          startedAt,
          tabId,
        } satisfies RecorderControlMessage);
      } catch (err) {
        console.warn('[recorder] init send failed for tab', tabId, err);
      }
    },
    async detach(tabId) {
      // Best-effort final flush + stop. Errors here are normal (tab closed,
      // navigated to chrome://, content script never landed).
      try {
        await chrome.tabs.sendMessage(tabId, {
          kind: RECORDER_MSG_KIND,
          type: 'final_flush',
        } satisfies RecorderControlMessage);
      } catch { /* ignore */ }
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: false },
          world: 'ISOLATED',
          func: () => {
            // Idempotent; the content script removes its own global on stop.
            const fn = (window as unknown as { __cebianRecorderStop?: () => void }).__cebianRecorderStop;
            if (typeof fn === 'function') fn();
          },
        });
      } catch { /* ignore */ }
    },
  });

  /** Recorder events from the content script. */
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!isRecorderRuntimeMessage(msg)) return false;
    if (msg.type === 'event') {
      // Defense in depth: only accept events from extension scripts running
      // in the currently observed tab. Without this, the picker / agent
      // content scripts on OTHER tabs could push events into the active
      // recording.
      if (sender.id !== chrome.runtime.id) return false;
      const expected = recorder.getObservedTabId();
      if (expected == null || sender.tab?.id !== expected) return false;
      recorder.pushEvent(msg.event);
    }
    return false;
  });

  // recorder 面向 UI 端口的接线（状态广播 / 首帧 / 成品投递 / 断连丢弃）。
  setupRecorderPortRelay();

  // 注册制消息路由：各域 client-handlers 先注册进查表（必须同步、在受理连接之前），
  // 路由器最后启动 —— 它会校验注册表覆盖了 CLIENT_MESSAGE_TYPES 全集，漏调 setup 启动即炸。
  setupChatClientHandlers();
  setupRecorderClientHandlers();
  setupMemoryClientHandlers();
  setupMcpBridge();
  setupClientRouter();

  // 最后一步：所有 onPortConnect / onPortDisconnect 订阅者都已注册，现在才开始受理
  // 连接。先开订阅、再开门，杜绝早到的连接漏掉域首帧。
  setupPortRegistry();
});

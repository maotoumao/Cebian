// Background-side recorder singleton.
//
// Owns the in-memory recording session, tab/window event listeners, the
// content-script attach/detach lifecycle (delegated to `attach()` / `detach()`
// hooks set by Task 4), and the cap watcher that auto-stops on overflow.
//
// State machine:
//   idle → recording → idle
// Transitions:
//   start()                  : idle    → recording
//   stop({discard:true})     : recording → idle, returns null
//   stop({discard:false})    : recording → idle, returns RecordedSession
//   internal cap-trigger     : recording → idle (via autoStop, which pushes
//                              the finalized session through the
//                              `onRecordingFinished` hook to whoever wired it)
//
// Sidepanel disconnect handling lives in `recorder/port-relay.ts`:
// when the initiator port disconnects (sidepanel/tab closed), the background
// calls `recorder.stop({ discard: true })` immediately. There is no
// auto-resume on reconnect — the user explicitly chose this behaviour
// (closing the surface = ending the recording session).
//
// While `status === 'recording'` the recorder holds a SW keep-alive token
// (see `lifecycle/keepalive.ts`) so a long quiet recording doesn't get terminated
// by Chrome's 30 s service-worker idle timeout — which would otherwise
// look like a spurious port disconnect and discard the in-flight session.

import {
  DEFAULT_RECORDER_OPTIONS,
  RECORDER_MAX_DURATION_MS,
  RECORDER_MAX_EVENTS,
} from '@/lib/recorder/constants';
import type { NetworkCaptureState } from '@/lib/recorder/network-types';
import type {
  RecordedEvent,
  RecordedEventWithoutBase,
  RecordedSession,
  RecorderOptions,
  TabEvent,
} from '@/lib/recorder/types';
import { acquireKeepAlive, releaseKeepAlive } from '../lifecycle/keepalive';
import { randomId } from '@/lib/utils';
import { startNetworkCapture, type NetworkCapture } from './network-capture';
import { eventOffset, sortByTime } from './timeline';

// ─── Types ────────────────────────────────────────────────────────────

export type RecorderStatus = {
  isRecording: boolean;
  startedAt: number | null;
  eventCount: number;
  truncated?: 'event_limit' | 'time_limit';
  /** Unique id of the sidepanel/tab instance that started the recording.
   *  Sidepanels compare this against their own per-instance id to decide
   *  whether to render the button in the owned (red, stoppable) state.
   *  `null` when idle. */
  initiatorInstanceId: string | null;
  /** The window currently being recorded. Tracks the user's focused window
   *  while recording (recording follows focus). `null` when idle. */
  activeWindowId: number | null;
  /** 网络录制的状态与已录请求数；本轮没开网络录制时不出现。 */
  networkState?: NetworkCaptureState;
  networkCount?: number;
};

export type RecorderStatusListener = (status: RecorderStatus) => void;

/** Called whenever a recording finishes with a deliverable session
 *  (either via `stop({discard:false})`, or the internal cap-trigger
 *  `autoStop()`). NOT fired for `stop({discard:true})` — discard means
 *  there is no session to deliver. Wired by the BG entrypoint to push
 *  the session to the initiator port as a `recorder_session` server
 *  message. Recorder doesn't know about ports or the wire protocol —
 *  it just hands off the sealed session. */
export type RecordingFinishedListener = (
  session: RecordedSession,
  /** 发起这一轮录制的端口（在定稿开始时记下）：收尾期间可能已有新一轮开始，不能按「当前发起方」投递。 */
  initiatorPort: chrome.runtime.Port | null,
) => void;

/** Hooks that Task 4 (content-script orchestration) plugs in. Kept as an
 *  injectable interface so this module can be unit-tested in isolation and
 *  so the recorder can be exercised end-to-end before Task 4 lands by
 *  supplying no-op hooks. */
export type RecorderAttachHooks = {
  /** Inject the content script into the given tab and arm it with `startedAt`.
   *  May reject; caller logs and continues (the tab is then unobserved). */
  attach(tabId: number, startedAt: number): Promise<void>;
  /** Send a final-flush message to the content script and disconnect it.
   *  Must be tolerant of a missing/dead script. */
  detach(tabId: number): Promise<void>;
};

const noopHooks: RecorderAttachHooks = {
  async attach() { /* will be replaced by Task 4 */ },
  async detach() { /* will be replaced by Task 4 */ },
};

/** Shallow equality for the keypress modifier array. The content script
 *  emits modifiers in a stable order (ctrl, shift, alt, meta) via
 *  `modifiersFromEvent`, so simple length + index comparison is sufficient —
 *  we don't need set semantics. Both `undefined` is treated as equal. */
function sameModifiers(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  const al = a?.length ?? 0;
  const bl = b?.length ?? 0;
  if (al !== bl) return false;
  for (let i = 0; i < al; i++) {
    if (a![i] !== b![i]) return false;
  }
  return true;
}

// ─── Singleton state ──────────────────────────────────────────────────

class Recorder {
  private status: 'idle' | 'recording' = 'idle';
  private startedAt: number | null = null;
  /** The port owned by the sidepanel/tab instance that started this
   *  recording. Used to gate stop() permissions (only this exact port can
   *  stop) and to decide on disconnect whether to discard the session
   *  (initiator port disconnects → instance is gone → discard). */
  private initiatorPort: chrome.runtime.Port | null = null;
  /** The instance id that the initiator port declared via `hello`. Mirrors
   *  `initiatorPort` but is JSON-serialisable so it can ride in the
   *  `recorder_status` broadcast for the client-side `isOwner` check. */
  private initiatorInstanceId: string | null = null;
  /** The window currently being recorded. Updated as the user focuses
   *  different windows during a recording. `chrome.tabs.*` events from
   *  other windows are silently ignored. */
  private activeWindowId: number | null = null;
  /** Tab that currently has the content script attached. */
  private observedTabId: number | null = null;
  /** Sticky flag: once attach failed for the current observedTabId, the next
   *  `tabs.onUpdated` with `status === 'complete'` will retry. Cleared on
   *  successful attach. */
  private observedAttachFailed = false;
  /** Generation counter for switchObservedTab. Each call bumps this; if a
   *  pending attach finds the generation has changed by the time it resolves,
   *  it discards its result rather than overwriting fresher state (e.g. user
   *  rapidly toggles between window A and B). */
  private switchGeneration = 0;
  /** 第几轮录制（只增不减）：迟到的异步结果据此判断自己是否还属于当前这一轮。 */
  private round = 0;
  private events: RecordedEvent[] = [];
  private truncated: 'event_limit' | 'time_limit' | undefined;
  private capTimer: ReturnType<typeof setInterval> | null = null;
  private statusBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  /** True iff we're currently holding a SW keep-alive token. Tracked so
   *  start/stop pairing remains balanced even across error paths. */
  private keepAliveHeld = false;
  private listeners = new Set<RecorderStatusListener>();
  private recordingFinishedListeners = new Set<RecordingFinishedListener>();
  private hooks: RecorderAttachHooks = noopHooks;
  /** 本轮实际使用的内容脚本钩子：不录操作时是空实现（不注入脚本），标签页事件照记。 */
  private contentHooks: RecorderAttachHooks = noopHooks;
  /** 本轮的网络采集；没开网络录制时为 null。 */
  private network: NetworkCapture | null = null;
  /**
   * 上一轮定稿时拆除内容脚本的任务。新一轮注入前先等它结束：拆除会调用页面里脚本的全局停止
   * 函数，晚于新脚本初始化执行就会把新一轮的脚本关掉。
   */
  private contentTeardown: Promise<void> = Promise.resolve();
  /** 最近一次获得焦点的窗口（不含失焦）。 */
  private focusedWindowId: number | null = null;
  /**
   * 已确定要切过去、但还在拆旧脚本的目标窗口。这期间录制仍算在旧窗口上，旧窗口在后台换了
   * 标签页（如认证标签页完成后自己关闭）不能取消这次切换。
   */
  private pendingWindowTarget: number | null = null;
  /** 本轮内正在拆除内容脚本的标签页：切回这个标签页时要等拆完再重新注入。 */
  private detachingTabs = new Map<number, Promise<void>>();
  /** Wrapped chrome.* listeners we attach on start and remove on stop, so
   *  there is no leak between sessions. */
  private chromeListeners: Array<() => void> = [];

  /** Task 4 calls this from the background entrypoint to wire injection. */
  setAttachHooks(hooks: RecorderAttachHooks): void {
    this.hooks = hooks;
  }

  // ─── Status subscription ────────────────────────────────────────────

  onStatusChange(listener: RecorderStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribe to recording-finished events. Fires once per recording on
   *  the transition recording → idle whenever a deliverable session was
   *  produced (manual `stop({discard:false})` or the internal cap-trigger
   *  `autoStop()`). NOT fired for `stop({discard:true})`. The BG entrypoint
   *  wires this to push the session to the initiator port. */
  onRecordingFinished(listener: RecordingFinishedListener): () => void {
    this.recordingFinishedListeners.add(listener);
    return () => this.recordingFinishedListeners.delete(listener);
  }

  getStatus(): RecorderStatus {
    return {
      isRecording: this.status === 'recording',
      startedAt: this.startedAt,
      eventCount: this.events.length,
      truncated: this.truncated,
      initiatorInstanceId: this.initiatorInstanceId,
      activeWindowId: this.activeWindowId,
      ...(this.network ? { networkState: this.network.state, networkCount: this.network.count } : {}),
    };
  }

  /** The port that started the active recording. The BG entrypoint compares
   *  this against the disconnecting port to decide whether to discard. */
  getInitiatorPort(): chrome.runtime.Port | null {
    return this.initiatorPort;
  }

  /** The tab whose content script is currently authorized to push events.
   *  Used by the runtime-message listener to reject events from other tabs
   *  (defense in depth — our own picker/agent scripts on other tabs would
   *  otherwise be able to inject events into the active recording). */
  getObservedTabId(): number | null {
    return this.observedTabId;
  }

  /** 这个标签页的内容脚本事件是否该收：本轮录操作、且是当前被跟踪的标签页。 */
  acceptsContentEvents(tabId: number | undefined): boolean {
    return this.status === 'recording'
      && this.contentHooks !== noopHooks
      && tabId != null
      && tabId === this.observedTabId;
  }

  /** Coalesce status broadcasts to ~5/sec so the sidepanel's badge updates
   *  without hammering postMessage during high-rate event windows. */
  private scheduleBroadcast(immediate = false): void {
    if (immediate) {
      if (this.statusBroadcastTimer) {
        clearTimeout(this.statusBroadcastTimer);
        this.statusBroadcastTimer = null;
      }
      this.flushBroadcast();
      return;
    }
    if (this.statusBroadcastTimer) return;
    this.statusBroadcastTimer = setTimeout(() => {
      this.statusBroadcastTimer = null;
      this.flushBroadcast();
    }, 200);
  }

  private flushBroadcast(): void {
    const snap = this.getStatus();
    for (const l of this.listeners) {
      try { l(snap); } catch (err) { console.warn('[recorder] listener threw:', err); }
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  /** Begin a recording owned by the given sidepanel instance. Only that
   *  exact port can stop it (BG checks `port === recorder.getInitiatorPort()`),
   *  and the recording is discarded immediately when that port disconnects.
   *  `initialWindowId` seeds `activeWindowId` so the recording starts in
   *  the window the user clicked from; recording-follows-focus moves it
   *  later via `handleWindowFocusChanged`. */
  async start(initiator: {
    port: chrome.runtime.Port;
    instanceId: string;
    initialWindowId: number;
    /** 录制哪些内容；缺省只录操作（旧客户端不带）。两项都关时不开始。 */
    options?: RecorderOptions;
  }): Promise<void> {
    const requested = initiator.options;
    // 两项都关：界面上开始按钮已置灰，这里再守一道，不替用户录没选的内容
    if (requested && !requested.interactions && !requested.network) {
      console.warn('[recorder] start ignored: no recording option selected');
      return;
    }
    // Flip status synchronously BEFORE any await so concurrent recorder_start
    // messages can't both pass the guard and double-install listeners.
    if (this.status === 'recording') {
      // Re-broadcast so a reconnecting client gets a fresh status.
      this.scheduleBroadcast(true);
      return;
    }
    this.status = 'recording';
    this.startedAt = Date.now();
    this.events = [];
    this.truncated = undefined;
    this.observedTabId = null;
    this.observedAttachFailed = false;
    // 只增不重置：上一轮还没收尾的切换（等查询、等注入）回来时，据此发现自己已过期
    this.switchGeneration++;
    this.round++;
    this.initiatorPort = initiator.port;
    this.initiatorInstanceId = initiator.instanceId;
    // Recording starts focused on the initiator window;
    // handleWindowFocusChanged moves it as the user alt-tabs.
    this.activeWindowId = initiator.initialWindowId;
    this.focusedWindowId = initiator.initialWindowId;
    const options = requested ?? DEFAULT_RECORDER_OPTIONS;
    this.contentHooks = options.interactions ? this.hooks : noopHooks;
    this.network = options.network
      ? startNetworkCapture(this.startedAt, () => this.scheduleBroadcast())
      : null;

    this.installChromeListeners();
    this.startCapTimer();
    this.acquireKeepAliveOnce();

    // Snapshot generation BEFORE any await: a focus-change event arriving
    // while we resolve the initial active tab will bump switchGeneration
    // and we'll skip the trailing switchObservedTab so we don't clobber
    // fresher state. (Review issue #6.)
    const startGen = this.switchGeneration;

    // Resolve the active tab in the initiator window AFTER state is
    // initialized so any concurrent listener callbacks see consistent state.
    let activeTab: chrome.tabs.Tab | undefined;
    try {
      const win = await chrome.windows.get(initiator.initialWindowId, { populate: true });
      activeTab = win.tabs?.find(t => t.active);
    } catch (err) {
      console.warn('[recorder] failed to populate initiator window:', err);
    }

    // Bail out if a focus change has already moved us elsewhere.
    if (this.status !== 'recording' || startGen !== this.switchGeneration) {
      this.scheduleBroadcast(true);
      return;
    }

    // Push an initial focus_changed marker for the starting tab so the
    // timeline always begins with a navigation context — this is the
    // sole page-context signal the agent will see at t≈0.
    if (activeTab?.id != null && activeTab.url) {
      this.pushEvent({
        kind: 'tab',
        event: 'focus_changed',
        tabId: activeTab.id,
        url: activeTab.url,
        title: activeTab.title,
        openerTabId: activeTab.openerTabId,
      });
    }

    if (activeTab?.id != null) {
      await this.switchObservedTab(activeTab.id, activeTab.url);
    }

    this.scheduleBroadcast(true);
  }

  /** Stop recording. Returns the sealed session unless `discard` is true,
   *  in which case all in-memory state is dropped and `null` is returned.
   *  Returns `null` if not currently recording — there is no separate
   *  pending-session state any more; cap-triggered auto-stops push their
   *  session through `onRecordingFinished` synchronously and clean up
   *  exactly like a manual stop. */
  async stop(opts: { discard?: boolean } = {}): Promise<RecordedSession | null> {
    return this.finalize(opts.discard === true);
  }

  // ─── Event ingestion ────────────────────────────────────────────────

  /** Called by the runtime-message handler in `index.ts` when the content
   *  script forwards a captured event. Caller already verified the message
   *  envelope; we just need to assign id/t and check caps.
   *
   *  We use a distributive helper instead of `Omit<RecordedEvent, 'id'|'t'>`
   *  because Omit on a discriminated union collapses the variants — TS would
   *  refuse the discriminator field (`event` / `kind` / `action`) on object
   *  literals. */
  pushEvent(event: RecordedEventWithoutBase, at?: number): void {
    if (this.status !== 'recording' || this.startedAt == null) return;
    if (this.truncated) return; // already capped, drop further events
    // 发生在本轮开始之前的事件（上一轮的脚本拆除时排出的残留）不属于这一轮
    if (at != null && at < this.startedAt) return;
    // 按页面端记下的发生时刻计算（见 ./timeline.ts）；后台自己产生的标签页事件没有 `at`
    const t = eventOffset(at, Date.now(), this.startedAt);

    // Coalesce repeated Backspace/Delete presses on the same target into a
    // `repeat` count on the previous event. Holding the key is already
    // dropped at the source (`ke.repeat` guard in the content script), so
    // this only catches rapid *independent* presses — the common case when
    // a user deletes a few characters to fix a typo. Other whitelisted
    // keys (Enter/Escape/Tab/arrows) stay individual: each press is
    // semantically distinct.
    if (
      event.kind === 'interaction'
      && event.action === 'keypress'
      && (event.key === 'Backspace' || event.key === 'Delete')
    ) {
      const last = this.events[this.events.length - 1];
      if (
        last
        && last.kind === 'interaction'
        && last.action === 'keypress'
        && last.key === event.key
        && last.target.selector === event.target.selector
        && sameModifiers(last.modifiers, event.modifiers)
        && Math.abs(t - last.t) < 1000
      ) {
        last.repeat = (last.repeat ?? 1) + 1;
        this.scheduleBroadcast();
        return;
      }
    }

    // Coalesce consecutive navigated events on the same tab to the same
    // URL. Chrome fires multiple `tabs.onUpdated` ticks during SPA route
    // changes and doc loads (loading/title-update/complete phases), each
    // producing a `navigated` with the same URL but progressively richer
    // title/openerTabId. Keep just the latest snapshot — title changes
    // mid-load are not user-meaningful. We only collapse when the LAST
    // event is the same navigated (no interaction/mutation in between),
    // so causality between user actions and navigations is preserved.
    //
    // No time-window guard: a single navigation can take seconds during
    // a slow load, and the user cannot trigger a second navigation on
    // the same tab while waiting for the first to complete. `last.t` is
    // intentionally NOT updated, mirroring the Backspace `repeat` rule —
    // keeping `t` at the FIRST navigated of the run preserves the timeline
    // ordering against the click/interaction that caused the navigation.
    if (event.kind === 'tab' && event.event === 'navigated') {
      const last = this.events[this.events.length - 1];
      if (
        last
        && last.kind === 'tab'
        && last.event === 'navigated'
        && last.tabId === event.tabId
        && last.url === event.url
      ) {
        // Update last in place. Prefer the newer non-empty title /
        // openerTabId so a richer late update wins over an earlier sparse
        // one; never overwrite a populated field with an empty one.
        if (event.title) last.title = event.title;
        if (event.openerTabId != null) last.openerTabId = event.openerTabId;
        this.scheduleBroadcast();
        return;
      }
    }

    const enriched = {
      ...event,
      id: randomId(8),
      t,
    } as RecordedEvent;
    this.events.push(enriched);

    if (this.events.length >= RECORDER_MAX_EVENTS) {
      this.truncated = 'event_limit';
      void this.autoStop();
      return;
    }

    this.scheduleBroadcast();
  }

  /** Cap-triggered finalization (event-count or duration limit). Just a
   *  thin fire-and-forget wrapper around the shared `finalize()` path so
   *  manual stop and cap-stop are guaranteed identical. There is no
   *  "pending" state — a recording either is active or has been finalized
   *  + handed off. */
  private async autoStop(): Promise<void> {
    await this.finalize(false);
  }

  /** Single sealed-session finalization path. Used by both manual `stop()`
   *  (with caller-supplied `discard`) and the internal cap-trigger
   *  `autoStop()` (always `discard=false`). Returns the session that was
   *  fanned out, or `null` on discard / when not recording. */
  private async finalize(discard: boolean): Promise<RecordedSession | null> {
    if (this.status !== 'recording' || this.startedAt == null) return null;

    const startedAt = this.startedAt;
    const initiatorPort = this.initiatorPort;
    // The session's windowId carries the window the recording was last
    // focused on; the active window may have moved during recording (visible
    // via tab events of kind 'focus_changed' in the event stream).
    const sessionWindowId = this.activeWindowId ?? -1;
    const observed = this.observedTabId;
    const contentHooks = this.contentHooks;
    const network = this.network;
    const sealedTruncated = this.truncated;
    // 事件按到达顺序入列，定稿时恢复成发生顺序
    const sealedEvents = sortByTime(this.events);

    // Synchronous teardown FIRST so subsequent messages see idle state.
    this.status = 'idle';
    this.removeChromeListeners();
    this.stopCapTimer();
    this.releaseKeepAliveOnce();
    this.startedAt = null;
    this.initiatorPort = null;
    this.initiatorInstanceId = null;
    this.activeWindowId = null;
    this.observedTabId = null;
    this.observedAttachFailed = false;
    this.switchGeneration++;
    this.events = [];
    this.truncated = undefined;
    this.contentHooks = noopHooks;
    this.network = null;
    // 网络采集立即停止接收新请求（stop 同步进入停止状态），再去等内容脚本拆除；丢弃时同样
    // 要停：释放调试连接，浏览器顶部的提示条随之消失
    const networkStopping = network?.stop().catch((err: unknown) => {
      console.warn('[recorder] network capture stop failed:', err);
      return undefined;
    });

    const teardown = observed != null
      ? contentHooks.detach(observed).catch((err) => console.warn('[recorder] detach failed:', err))
      : Promise.resolve();
    // 接在尚未结束的拆除后面，不能用一个已完成的任务把它们覆盖掉
    this.addContentTeardown(teardown);
    // 本轮切换中还没拆完的也接进去：下一轮可能马上注入到那个标签页
    for (const pending of this.detachingTabs.values()) this.addContentTeardown(pending);
    this.detachingTabs.clear();
    await teardown;

    // 结束时刻不含网络收尾（取完未完成的响应体、释放调试连接）的时间
    const endedAt = Date.now();
    const networkLog = await networkStopping;
    const session: RecordedSession | null = discard ? null : {
      version: 1,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      windowId: sessionWindowId,
      events: sealedEvents,
      truncated: sealedTruncated,
      ...(networkLog ? { network: networkLog } : {}),
    };

    // Fan the finalized session out to subscribers (the BG entrypoint
    // forwards it to the initiator port). Skipped on `discard` because
    // there's no session to deliver. Listener errors are swallowed so one
    // bad subscriber doesn't break others.
    if (session) {
      for (const l of this.recordingFinishedListeners) {
        try { l(session, initiatorPort); } catch (err) { console.warn('[recorder] recordingFinished listener threw:', err); }
      }
    }

    this.scheduleBroadcast(true);
    return session;
  }

  // ─── Tab/window listeners ───────────────────────────────────────────

  private installChromeListeners(): void {
    const onActivated = (info: { tabId: number; windowId: number }) => {
      void this.handleTabActivated(info.tabId, info.windowId);
    };
    const onUpdated = (
      tabId: number,
      change: chrome.tabs.OnUpdatedInfo,
      tab: chrome.tabs.Tab,
    ) => {
      void this.handleTabUpdated(tabId, change, tab);
    };
    const onRemoved = (tabId: number, info: { windowId: number; isWindowClosing: boolean }) => {
      void this.handleTabRemoved(tabId, info);
    };
    const onCreated = (tab: chrome.tabs.Tab) => {
      void this.handleTabCreated(tab);
    };
    const onWindowFocus = (windowId: number) => {
      void this.handleWindowFocusChanged(windowId);
    };

    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.onCreated.addListener(onCreated);
    chrome.windows.onFocusChanged.addListener(onWindowFocus);

    this.chromeListeners.push(
      () => chrome.tabs.onActivated.removeListener(onActivated),
      () => chrome.tabs.onUpdated.removeListener(onUpdated),
      () => chrome.tabs.onRemoved.removeListener(onRemoved),
      () => chrome.tabs.onCreated.removeListener(onCreated),
      () => chrome.windows.onFocusChanged.removeListener(onWindowFocus),
    );
  }

  private removeChromeListeners(): void {
    for (const undo of this.chromeListeners) {
      try { undo(); } catch { /* ignore */ }
    }
    this.chromeListeners = [];
  }

  private async handleTabActivated(tabId: number, windowId: number): Promise<void> {
    if (windowId !== this.activeWindowId) return; // only the currently-focused window
    // 正在切往另一个窗口、且焦点仍在那里：这是旧窗口在后台换标签页，不跟着切
    if (this.pendingWindowTarget != null && this.focusedWindowId === this.pendingWindowTarget) return;
    // 每次激活都是一次新的切换意图：连续切换时以最后一次为准，先发出的查询晚回来也作废
    const gen = ++this.switchGeneration;
    const tab = await safeGetTab(tabId);
    // 查询期间录制已停止、换了一轮或又切到了别处：结果作废，不能动到新的状态
    if (gen !== this.switchGeneration || this.status !== 'recording') return;
    this.pushTabEvent('focus_changed', tabId, tab);
    await this.switchObservedTab(tabId, tab?.url);
  }

  private async handleTabUpdated(
    tabId: number,
    change: chrome.tabs.OnUpdatedInfo,
    tab: chrome.tabs.Tab,
  ): Promise<void> {
    if (tab.windowId !== this.activeWindowId) return;
    if (tabId !== this.observedTabId) return; // only care about the observed tab
    if (change.url || (change.status === 'loading' && tab.url)) {
      this.pushTabEvent('navigated', tabId, tab);
      // 网络采集在跳转一开始就要连上，才能录到新页面的文档请求（不等 complete）
      this.network?.tabNavigated(tabId, tab.url);
      // Re-attach: the previous content script was destroyed by navigation.
      // Detach is implicit (script is gone); just attach again once loaded.
      this.observedAttachFailed = true; // force a retry on `complete`
    } else if (change.status === 'complete' && this.observedAttachFailed && !this.detachingTabs.has(tabId)) {
      // （正在拆除的标签页是用户切走了：切回来时激活路径会重新接上，这里不注入，免得留下没人跟踪的脚本）
      // No new url in this update, but a previous attach failed (or a
      // navigation just completed in a separate update). Try again.
      await this.switchObservedTab(tabId, tab.url);
    }
  }

  private async handleTabRemoved(
    tabId: number,
    info: { windowId: number; isWindowClosing: boolean },
  ): Promise<void> {
    // 网络采集对访问过的标签页都持有连接（不限当前窗口），关闭时释放
    this.network?.tabClosed(tabId);
    if (info.windowId !== this.activeWindowId) return;
    this.pushEvent({
      kind: 'tab',
      event: 'closed',
      tabId,
      url: '',
    });
    if (tabId === this.observedTabId) {
      this.observedTabId = null;
      // Don't proactively pick a new tab here — chrome.tabs.onActivated will
      // fire for whichever tab Chrome focuses next, and that path handles attach.
    }
  }

  private async handleTabCreated(tab: chrome.tabs.Tab): Promise<void> {
    if (tab.windowId !== this.activeWindowId) return;
    if (tab.id == null) return; // skip rather than emit a -1 sentinel
    this.pushTabEvent('created', tab.id, tab);
  }

  /** Recording follows the user's focused window. When focus moves to a
   *  different normal window, detach from the previous tab, switch the
   *  active scope, and attach to the new window's active tab. Focus loss
   *  (`WINDOW_ID_NONE`) and devtools/popup windows are ignored — we keep
   *  the previous active tab observed so brief excursions don't churn
   *  attach/detach. */
  private async handleWindowFocusChanged(windowId: number): Promise<void> {
    if (this.status !== 'recording') return;
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    // 记下最新的焦点：进行中的跨窗口切换据此发现用户已经切回或又切走了。切回当前窗口本身
    // 不动 switchGeneration——同一窗口里正在进行的标签页切换（如从别的应用点开链接时先激活
    // 新标签页、再把窗口提到前台）不能被它作废
    this.focusedWindowId = windowId;
    if (windowId === this.activeWindowId) return;
    const round = this.round;

    let win: chrome.windows.Window;
    try {
      win = await chrome.windows.get(windowId);
    } catch {
      return; // window vanished
    }
    if (this.focusedWindowId !== windowId || this.status !== 'recording' || round !== this.round) return;
    // 查询期间另一次切换已经把录制切到了这个窗口
    if (windowId === this.activeWindowId) return;
    // Ignore devtools / popup / panel windows — recording stays on the last
    // normal window the user was using.
    if (win.type !== 'normal') return;

    // 确定要切过去了才作废进行中的切换（开发者工具、弹窗不打断当前窗口里的切换）
    const gen = ++this.switchGeneration;

    const prev = this.observedTabId;
    if (prev != null) {
      this.pendingWindowTarget = windowId;
      try {
        await this.detachContent(this.contentHooks, prev);
      } finally {
        if (this.pendingWindowTarget === windowId) this.pendingWindowTarget = null;
      }
      if (gen !== this.switchGeneration || this.status !== 'recording') return;
      if (this.focusedWindowId !== windowId) {
        // 拆除期间焦点又移走了（切回原窗口、或弹出了登录弹窗等）：放弃这次切换，按录制所在窗口
        // 真正激活的标签页重新对准，把刚才拆掉的补回来。焦点若去了另一个普通窗口，那边的处理
        // 随后会再切过去
        await this.realignActiveTab(gen);
        return;
      }
    }
    this.observedTabId = null;
    this.observedAttachFailed = false;
    this.activeWindowId = windowId;

    // 现在才查这个窗口激活的标签页：拆旧脚本期间用户可能已在新窗口里换了标签页（那次激活
    // 事件因为 activeWindowId 还没切过来而被忽略了）
    let activeTab: chrome.tabs.Tab | undefined;
    try {
      [activeTab] = await chrome.tabs.query({ active: true, windowId });
    } catch {
      activeTab = undefined;
    }
    if (gen !== this.switchGeneration || this.status !== 'recording') return;
    if (activeTab?.id != null) {
      this.pushTabEvent('focus_changed', activeTab.id, activeTab);
      await this.switchObservedTab(activeTab.id, activeTab.url);
    }
  }

  /** 重新对准当前窗口里真正激活的标签页（跨窗口切换中途被取消、已拆掉的内容脚本要补回来）。 */
  private async realignActiveTab(gen: number): Promise<void> {
    if (this.activeWindowId == null) return;
    let active: chrome.tabs.Tab | undefined;
    try {
      [active] = await chrome.tabs.query({ active: true, windowId: this.activeWindowId });
    } catch {
      return;
    }
    if (gen !== this.switchGeneration || this.status !== 'recording' || active?.id == null) return;
    if (active.id !== this.observedTabId) this.pushTabEvent('focus_changed', active.id, active);
    await this.switchObservedTab(active.id, active.url);
  }

  /** Detach old observed tab (if any) and attach to the new one. Guarded
   *  by `switchGeneration`: if focus moves to another window mid-attach,
   *  the resolved attach is discarded so we don't overwrite the newer
   *  observed-tab state. */
  private async switchObservedTab(tabId: number, url: string | undefined): Promise<void> {
    const gen = this.switchGeneration;
    const round = this.round;
    const prev = this.observedTabId;
    // 记下这一轮的钩子：停止后 contentHooks 会被换成空实现，迟到的清理仍要用注入时的那一套
    const hooks = this.contentHooks;
    // 网络采集与内容脚本各管各的：observe 幂等，不受内容脚本注入成败影响
    this.network?.observe(tabId, url);
    if (prev === tabId && !this.observedAttachFailed) return;
    if (prev != null && prev !== tabId) {
      await this.detachContent(hooks, prev);
      // Generation may have been bumped while detach awaited.
      if (gen !== this.switchGeneration) return;
    }
    // 等上一轮拆完内容脚本、以及本轮对这个标签页尚未结束的拆除，再注入；等待期间又追加了
    // 拆除（迟到注入的清理等）就接着等
    for (;;) {
      const teardown = this.contentTeardown;
      const detaching = this.detachingTabs.get(tabId);
      await Promise.all([teardown, detaching]);
      if (gen !== this.switchGeneration) return;
      if (teardown === this.contentTeardown && detaching === this.detachingTabs.get(tabId)) break;
    }
    this.observedTabId = tabId;
    this.observedAttachFailed = false;
    if (this.startedAt == null) return;
    let attached = false;
    try {
      await hooks.attach(tabId, this.startedAt);
      attached = true;
    } catch (err) {
      if (gen !== this.switchGeneration) return;
      // Restricted page or injection error. Keep observedTabId set so the
      // tab event filters in handleTab* still treat it as "the tab we care
      // about", but mark attach as failed so a subsequent navigation
      // (`change.status === 'complete'`) gets a retry.
      console.debug('[recorder] attach failed for tab', tabId, err);
      this.observedAttachFailed = true;
      return;
    }
    // Attach succeeded. If a newer focus change has happened, the script
    // is now leaked w.r.t. our state — always detach it before returning,
    // regardless of whether observedTabId still equals tabId. Otherwise
    // we'd leave a content script attached that we no longer track.
    // (Review issue #3.)
    if (gen !== this.switchGeneration) {
      // 跟踪的仍是这个标签页、钩子相同、且没有人正在拆它：让 generation 变化的那次切换要么继续
      // 用这个标签页（会自己注入并初始化），要么会把它当作上一个标签页拆掉——这里都不必插手，
      // 也不能清它的跟踪状态（拆除按标签页生效，分不清脚本是谁注入的）。正在拆的标签页不算被
      // 接管：拆除已经执行过的话，这次迟到注入的脚本要再拆一次
      const takenOver = this.status === 'recording'
        && this.observedTabId === tabId
        && this.contentHooks === hooks
        && !this.detachingTabs.has(tabId);
      if (takenOver) return;
      if (round === this.round && this.observedTabId === tabId) this.observedTabId = null;
      if (round === this.round) {
        await this.detachContent(hooks, tabId);
      } else {
        // 已经换了一轮：这次拆除归入跨轮的拆除链，新一轮注入前会等它
        const teardown = hooks.detach(tabId).catch((err) => console.warn('[recorder] stale-attach detach failed:', err));
        this.addContentTeardown(teardown);
        await teardown;
      }
      return;
    }
    void attached;
  }

  /**
   * 拆除某个标签页的内容脚本（本轮内）。拆除期间把它登记为「正在拆」，并在它仍是被跟踪的
   * 标签页时标记需要重新注入：用户在拆完之前又切回来，切换会等拆完再重新注入。
   */
  private async detachContent(hooks: RecorderAttachHooks, tabId: number): Promise<void> {
    if (this.observedTabId === tabId) this.observedAttachFailed = true;
    // 同一标签页已有拆除在进行：与它合并，等待者要等两次都结束
    const previous = this.detachingTabs.get(tabId);
    const current = hooks.detach(tabId).catch((err) => console.warn('[recorder] detach failed:', err));
    const done: Promise<void> = Promise.all([previous, current])
      .then(() => undefined)
      .finally(() => {
        if (this.detachingTabs.get(tabId) === done) this.detachingTabs.delete(tabId);
      });
    this.detachingTabs.set(tabId, done);
    await done;
  }

  /** 把一次跨轮的拆除接进拆除链。 */
  private addContentTeardown(teardown: Promise<void>): void {
    const previous = this.contentTeardown;
    this.contentTeardown = Promise.all([previous, teardown]).then(() => undefined);
  }

  private pushTabEvent(
    eventKind: TabEvent['event'],
    tabId: number,
    tab: chrome.tabs.Tab | undefined,
  ): void {
    this.pushEvent({
      kind: 'tab',
      event: eventKind,
      tabId,
      url: tab?.url ?? '',
      title: tab?.title,
      openerTabId: tab?.openerTabId,
    });
  }

  // ─── Cap watcher ────────────────────────────────────────────────────

  private startCapTimer(): void {
    this.stopCapTimer();
    this.capTimer = setInterval(() => {
      if (this.status !== 'recording' || this.startedAt == null) return;
      if (this.truncated) return;
      const elapsed = Date.now() - this.startedAt;
      if (elapsed >= RECORDER_MAX_DURATION_MS) {
        this.truncated = 'time_limit';
        void this.autoStop();
      }
    }, 1000);
  }

  private stopCapTimer(): void {
    if (this.capTimer) {
      clearInterval(this.capTimer);
      this.capTimer = null;
    }
  }

  // ─── SW keep-alive ───────────────────────────────────────────────

  /** Acquire / release wrappers around the shared `lifecycle/keepalive` ref count.
   *  We track ownership locally with `keepAliveHeld` so paired calls remain
   *  balanced even if `start()` / `stop()` are called in unexpected orders
   *  (e.g. start while already recording is a no-op and must NOT acquire). */
  private acquireKeepAliveOnce(): void {
    if (this.keepAliveHeld) return;
    this.keepAliveHeld = true;
    acquireKeepAlive();
  }

  private releaseKeepAliveOnce(): void {
    if (!this.keepAliveHeld) return;
    this.keepAliveHeld = false;
    releaseKeepAlive();
  }

  // ─── Debug ──────────────────────────────────────────────────────────

  /** Internal use only — exposed for development and tests. */
  getDebugSnapshot() {
    return {
      status: this.status,
      startedAt: this.startedAt,
      initiatorInstanceId: this.initiatorInstanceId,
      activeWindowId: this.activeWindowId,
      observedTabId: this.observedTabId,
      eventCount: this.events.length,
      truncated: this.truncated,
      events: this.events,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function safeGetTab(tabId: number): Promise<chrome.tabs.Tab | undefined> {
  try { return await chrome.tabs.get(tabId); }
  catch { return undefined; }
}

// ─── Singleton export ─────────────────────────────────────────────────

export const recorder = new Recorder();

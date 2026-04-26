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
// Sidepanel disconnect handling lives in `entrypoints/background/index.ts`:
// when the initiator port disconnects (sidepanel/tab closed), the background
// calls `recorder.stop({ discard: true })` immediately. There is no
// auto-resume on reconnect — the user explicitly chose this behaviour
// (closing the surface = ending the recording session).
//
// While `status === 'recording'` the recorder holds a SW keep-alive token
// (see `sw-keepalive.ts`) so a long quiet recording doesn't get terminated
// by Chrome's 30 s service-worker idle timeout — which would otherwise
// look like a spurious port disconnect and discard the in-flight session.

import {
  RECORDER_MAX_DURATION_MS,
  RECORDER_MAX_EVENTS,
} from '@/lib/recorder/constants';
import type {
  RecordedEvent,
  RecordedEventWithoutBase,
  RecordedSession,
  TabEvent,
} from '@/lib/recorder/types';
import { acquireKeepAlive, releaseKeepAlive } from './sw-keepalive';
import { randomId } from '@/lib/utils';

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
};

export type RecorderStatusListener = (status: RecorderStatus) => void;

/** Called whenever a recording finishes with a deliverable session
 *  (either via `stop({discard:false})`, or the internal cap-trigger
 *  `autoStop()`). NOT fired for `stop({discard:true})` — discard means
 *  there is no session to deliver. Wired by the BG entrypoint to push
 *  the session to the initiator port as a `recorder_session` server
 *  message. Recorder doesn't know about ports or the wire protocol —
 *  it just hands off the sealed session. */
export type RecordingFinishedListener = (session: RecordedSession) => void;

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
  }): Promise<void> {
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
    this.switchGeneration = 0;
    this.initiatorPort = initiator.port;
    this.initiatorInstanceId = initiator.instanceId;
    // Recording starts focused on the initiator window;
    // handleWindowFocusChanged moves it as the user alt-tabs.
    this.activeWindowId = initiator.initialWindowId;

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
      await this.switchObservedTab(activeTab.id);
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
  pushEvent(event: RecordedEventWithoutBase): void {
    if (this.status !== 'recording' || this.startedAt == null) return;
    if (this.truncated) return; // already capped, drop further events

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
        && (Date.now() - this.startedAt) - last.t < 1000
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
      t: Date.now() - this.startedAt,
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
    // The session's windowId carries the window the recording was last
    // focused on; the active window may have moved during recording (visible
    // via tab events of kind 'focus_changed' in the event stream).
    const sessionWindowId = this.activeWindowId ?? -1;
    const observed = this.observedTabId;
    const sealedTruncated = this.truncated;
    const sealedEvents = this.events;

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
    this.switchGeneration = 0;
    this.events = [];
    this.truncated = undefined;

    if (observed != null) {
      try { await this.hooks.detach(observed); }
      catch (err) { console.warn('[recorder] detach failed:', err); }
    }

    const endedAt = Date.now();
    const session: RecordedSession | null = discard ? null : {
      version: 1,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      windowId: sessionWindowId,
      events: sealedEvents,
      truncated: sealedTruncated,
    };

    // Fan the finalized session out to subscribers (the BG entrypoint
    // forwards it to the initiator port). Skipped on `discard` because
    // there's no session to deliver. Listener errors are swallowed so one
    // bad subscriber doesn't break others.
    if (session) {
      for (const l of this.recordingFinishedListeners) {
        try { l(session); } catch (err) { console.warn('[recorder] recordingFinished listener threw:', err); }
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
    const tab = await safeGetTab(tabId);
    this.pushTabEvent('focus_changed', tabId, tab);
    await this.switchObservedTab(tabId);
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
      // Re-attach: the previous content script was destroyed by navigation.
      // Detach is implicit (script is gone); just attach again once loaded.
      this.observedAttachFailed = true; // force a retry on `complete`
    } else if (change.status === 'complete' && this.observedAttachFailed) {
      // No new url in this update, but a previous attach failed (or a
      // navigation just completed in a separate update). Try again.
      await this.switchObservedTab(tabId);
    }
  }

  private async handleTabRemoved(
    tabId: number,
    info: { windowId: number; isWindowClosing: boolean },
  ): Promise<void> {
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
    if (windowId === this.activeWindowId) return;

    // Bump generation FIRST so any in-flight switchObservedTab from the
    // previous focus bails out. Capture our own gen so we can detect a
    // newer focus event clobbering us mid-await. (Review issue #1.)
    const gen = ++this.switchGeneration;

    let win: chrome.windows.Window;
    try {
      win = await chrome.windows.get(windowId, { populate: true });
    } catch {
      return; // window vanished
    }
    if (gen !== this.switchGeneration) return;
    if (this.status !== 'recording') return;
    // Ignore devtools / popup / panel windows — recording stays on the last
    // normal window the user was using.
    if (win.type !== 'normal') return;

    const prev = this.observedTabId;
    if (prev != null) {
      try { await this.hooks.detach(prev); }
      catch (err) { console.warn('[recorder] detach failed on focus change:', err); }
      // Re-check after detach await: another focus event may have moved
      // us again. Don't mutate state if so.
      if (gen !== this.switchGeneration) return;
      if (this.status !== 'recording') return;
    }
    this.observedTabId = null;
    this.observedAttachFailed = false;
    this.activeWindowId = windowId;

    const activeTab = win.tabs?.find(t => t.active);
    if (activeTab?.id != null) {
      this.pushTabEvent('focus_changed', activeTab.id, activeTab);
      await this.switchObservedTab(activeTab.id);
    }
  }

  /** Detach old observed tab (if any) and attach to the new one. Guarded
   *  by `switchGeneration`: if focus moves to another window mid-attach,
   *  the resolved attach is discarded so we don't overwrite the newer
   *  observed-tab state. */
  private async switchObservedTab(tabId: number): Promise<void> {
    const gen = this.switchGeneration;
    const prev = this.observedTabId;
    if (prev === tabId && !this.observedAttachFailed) return;
    if (prev != null && prev !== tabId) {
      try { await this.hooks.detach(prev); }
      catch (err) { console.warn('[recorder] detach failed:', err); }
      // Generation may have been bumped while detach awaited.
      if (gen !== this.switchGeneration) return;
    }
    this.observedTabId = tabId;
    this.observedAttachFailed = false;
    if (this.startedAt == null) return;
    let attached = false;
    try {
      await this.hooks.attach(tabId, this.startedAt);
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
      if (this.observedTabId === tabId) this.observedTabId = null;
      try { await this.hooks.detach(tabId); }
      catch (err) { console.warn('[recorder] stale-attach detach failed:', err); }
      return;
    }
    void attached;
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

  /** Acquire / release wrappers around the shared `sw-keepalive` ref count.
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

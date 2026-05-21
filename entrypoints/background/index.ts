import { setupOAuthRefresh } from './oauth-refresh';
import { agentManager } from './agent-manager';
import { sessionStore } from './session-store';
import { recorder } from './recorder';
import { seedDevStorage } from './dev-seed';
import { invalidateSkillIndex } from '@/lib/ai-config/scanner';
import { getMCPManager } from '@/lib/mcp/manager';
import { AGENT_PORT_NAME, type ClientMessage, type ServerMessage } from '@/lib/protocol';
import { isRecorderRuntimeMessage, RECORDER_MSG_KIND, type RecorderControlMessage } from '@/lib/recorder/protocol';
import { isInjectablePage } from '@/lib/tab-helpers';
import { vfs } from '@/lib/vfs';

/**
 * Grace period after the last subscribed port disconnects before the agent
 * is cancelled. Lets the user close the sidepanel briefly (switch tabs,
 * copy text, navigate away) without killing an in-flight response.
 *
 * The agent's keepalive (`AgentManager.updateKeepAlive`) prevents the SW
 * from being terminated while `isRunning === true`, so the timer is
 * guaranteed to fire as long as the agent is still working.
 */
const AGENT_GRACE_PERIOD_MS = 60_000;

export default defineBackground(() => {
  console.log('Cebian background started', { id: browser.runtime.id });

  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));

  setupOAuthRefresh();

  // Dev-only: seed a custom provider from .env.local if configured.
  // No-op in production builds and when WXT_DEV_API_KEY is empty.
  void seedDevStorage().catch(err => console.warn('[dev-seed] failed:', err));

  // ─── Port management ───

  /** All connected ports and the session each is subscribed to. */
  const ports = new Map<chrome.runtime.Port, { subscribedSession: string | null; instanceId: string | null }>();

  /**
   * Pending grace cancels keyed by sessionId. When the last subscriber
   * disconnects we don't cancel the agent immediately — we schedule a
   * cancel `AGENT_GRACE_PERIOD_MS` later so a quick reconnect (user closes
   * then reopens the sidepanel) keeps the stream alive.
   */
  const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleGraceCancel(sessionId: string): void {
    // Replace any existing timer so the most recent disconnect wins.
    const existing = graceTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      graceTimers.delete(sessionId);
      // Defensive: ports map is the source of truth. In a single-threaded
      // SW runtime `clearTimeout` reliably cancels a pending timer, so this
      // check normally always passes — but it costs nothing to verify.
      const stillNoSubscriber = ![...ports.values()].some(s => s.subscribedSession === sessionId);
      if (stillNoSubscriber) {
        agentManager.cancel(sessionId).catch(err =>
          console.warn(`[grace-cancel] agent cancel failed for ${sessionId}:`, err),
        );
      }
    }, AGENT_GRACE_PERIOD_MS);
    graceTimers.set(sessionId, timer);
  }

  function cancelGrace(sessionId: string): void {
    const t = graceTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      graceTimers.delete(sessionId);
    }
  }

  /**
   * Post to one port, swallowing the "disconnected port" error.
   *
   * Chrome throws when you `postMessage` to a port whose other side has
   * closed (sidepanel closed mid-flight, tab navigated away, SW idle
   * suspension on the far end). For our use — sending status updates and
   * RPC replies — the right behaviour is "best effort, don't escalate".
   * Every BG → sidepanel post in this file goes through here so the
   * behaviour is uniform and one inline `try/catch` doesn't drift away
   * from another over time.
   */
  function safePost(port: chrome.runtime.Port, msg: ServerMessage): void {
    try { port.postMessage(msg); } catch { /* port disconnected */ }
  }

  /** Send a message to all ports subscribed to a given session. */
  function broadcast(sessionId: string, msg: ServerMessage): void {
    for (const [port, state] of ports) {
      if (state.subscribedSession === sessionId) {
        safePost(port, msg);
      }
    }
  }

  agentManager.setBroadcast(broadcast);

  // ─── Recorder broadcast ───

  /** Send recorder_status to every connected port (recorder is a global,
   *  per-instance concept, not session-scoped). */
  function broadcastRecorderStatus(): void {
    const status = recorder.getStatus();
    const msg: ServerMessage = {
      type: 'recorder_status',
      isRecording: status.isRecording,
      startedAt: status.startedAt,
      eventCount: status.eventCount,
      truncated: status.truncated,
      initiatorInstanceId: status.initiatorInstanceId,
      activeWindowId: status.activeWindowId,
    };
    for (const [port] of ports) {
      safePost(port, msg);
    }
  }
  recorder.onStatusChange(broadcastRecorderStatus);

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

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== AGENT_PORT_NAME) return;

    ports.set(port, { subscribedSession: null, instanceId: null });
    safePost(port, { type: 'connected' });

    // Sync recorder state to the new port. Without this, a sidepanel that
    // opens during an active recording (or reconnects after a brief SW
    // suspension) would display "idle" until the next event triggers a
    // broadcast.
    const recStatus = recorder.getStatus();
    safePost(port, {
      type: 'recorder_status',
      isRecording: recStatus.isRecording,
      startedAt: recStatus.startedAt,
      eventCount: recStatus.eventCount,
      truncated: recStatus.truncated,
      initiatorInstanceId: recStatus.initiatorInstanceId,
      activeWindowId: recStatus.activeWindowId,
    });

    port.onMessage.addListener(async (msg: ClientMessage) => {
      try {
        await handleClientMessage(port, msg);
      } catch (err: any) {
        safePost(port, {
          type: 'error',
          sessionId: null,
          error: err.message ?? String(err),
        });
      }
    });

    port.onDisconnect.addListener(() => {
      const disconnectedState = ports.get(port);
      const sessionId = disconnectedState?.subscribedSession;
      ports.delete(port);

      // If no other port is subscribed to this session, schedule a grace
      // cancel instead of killing the agent immediately. This lets the user
      // briefly close the sidepanel without aborting an in-flight response.
      if (sessionId) {
        const hasOtherSubscriber = [...ports.values()].some(s => s.subscribedSession === sessionId);
        if (!hasOtherSubscriber) {
          scheduleGraceCancel(sessionId);
        }
      }

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
  });

  async function handleClientMessage(port: chrome.runtime.Port, msg: ClientMessage): Promise<void> {
    const state = ports.get(port);
    if (!state) return;

    switch (msg.type) {
      case 'subscribe': {
        state.subscribedSession = msg.sessionId;
        // A new subscriber arrived — cancel any pending grace timer for this
        // session so we don't kill an agent that's about to be observed again.
        cancelGrace(msg.sessionId);
        // Send current agent state if the agent is running for this session
        if (agentManager.getSessionState(msg.sessionId)) {
          // Title isn't part of the in-memory agent state — load it from DB
          // so the subscriber's header can show the session title even when
          // (re)subscribing mid-stream.
          const session = await sessionStore.load(msg.sessionId);
          // Re-snapshot AFTER the await: during the DB load the agent could
          // have emitted message_update / agent_end and broadcast() already
          // forwarded those to this port (we set subscribedSession above).
          // Posting an older snapshot here would regress the hook's
          // `messages` state.
          const fresh = agentManager.getSessionState(msg.sessionId);
          if (fresh) {
            safePost(port, {
              type: 'session_state',
              sessionId: msg.sessionId,
              title: session?.title ?? '',
              messages: fresh.messages,
              isRunning: fresh.isRunning,
            });
          } else {
            // Agent finished during the await — fall through to DB-based
            // session_loaded using the row we already loaded.
            safePost(port, {
              type: 'session_loaded',
              session: session ?? null,
            });
          }
        } else {
          // Agent not running — load from DB
          const session = await sessionStore.load(msg.sessionId);
          if (session) {
            safePost(port, {
              type: 'session_loaded',
              session,
            });
          } else {
            // Session not found in DB
            safePost(port, {
              type: 'session_loaded',
              session: null,
            });
          }
        }
        break;
      }

      case 'unsubscribe':
        state.subscribedSession = null;
        break;

      case 'prompt': {
        const sessionId = msg.sessionId ?? crypto.randomUUID();
        state.subscribedSession = sessionId;
        // Start the agent (async — events will be broadcast).
        // For new sessions, agentManager.prompt() persists the session and
        // broadcasts 'session_created' before starting, so the client can
        // navigate to /chat/<id> immediately.
        agentManager.prompt(sessionId, msg.text, msg.attachments).catch((err) => {
          safePost(port, {
            type: 'error',
            sessionId,
            error: err.message ?? String(err),
          });
        });
        break;
      }

      case 'cancel':
        // User-initiated cancel — immediate, no grace period.
        cancelGrace(msg.sessionId);
        agentManager.cancel(msg.sessionId).catch(err =>
          console.warn(`[cancel] agent cancel failed for ${msg.sessionId}:`, err),
        );
        break;

      case 'retry': {
        // Re-run the last user turn. Errors propagate via the `error`
        // ServerMessage just like `prompt` so the sidepanel can surface
        // "no user message found" / "agent already running" / model setup
        // failures consistently.
        state.subscribedSession = msg.sessionId;
        agentManager.retry(msg.sessionId).catch((err) => {
          safePost(port, {
            type: 'error',
            sessionId: msg.sessionId,
            error: err.message ?? String(err),
          });
        });
        break;
      }

      case 'resolve_tool':
        agentManager.resolveTool(msg.sessionId, msg.toolName, msg.response);
        break;

      case 'cancel_tool':
        agentManager.cancelTool(msg.sessionId, msg.toolName);
        break;

      case 'session_load': {
        const session = await sessionStore.load(msg.sessionId);
        safePost(port, {
          type: 'session_loaded',
          session: session ?? null,
        });
        break;
      }

      case 'session_list': {
        const sessions = await sessionStore.list();
        // Annotate with live running state so the UI can show an indicator
        // for sessions whose agent is currently mid-stream in the background.
        const annotated = sessions.map(s => ({
          ...s,
          isRunning: agentManager.getSessionState(s.id)?.isRunning === true,
        }));
        safePost(port, {
          type: 'session_list_result',
          sessions: annotated,
        });
        break;
      }

      case 'session_delete': {
        // Validate sessionId before any path construction. The handler is a
        // message boundary that must not trust client input — interpolating
        // a malicious value (empty, `..`, `/etc`, `a/../b`) into the path
        // would let `vfs.rm({recursive:true})` escape `/workspaces/` and
        // wipe `/`, `/home`, or `~/.cebian/` (skills + prompts).
        // Lock to the shape of `crypto.randomUUID()`.
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!UUID_RE.test(msg.sessionId)) {
          console.warn('[session_delete] rejecting non-UUID sessionId:', msg.sessionId);
          break;
        }
        // Cancel any pending grace timer — the session is going away.
        cancelGrace(msg.sessionId);
        // Best-effort workspace cleanup. `vfs.rm({force:true})` already
        // tolerates ENOENT, so no exists pre-check is needed. Tolerate any
        // other VFS error and continue with DB deletion — a leaked workspace
        // is recoverable via the VFS browser; an orphan session row would
        // be more confusing.
        const workspacePath = `/workspaces/${msg.sessionId}`;
        try {
          await vfs.rm(workspacePath, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[session_delete] failed to remove workspace ${workspacePath}:`, err);
        }
        await sessionStore.delete(msg.sessionId);
        agentManager.destroySession(msg.sessionId);
        // Broadcast deletion to all connected ports
        for (const [p] of ports) {
          safePost(p, {
            type: 'session_deleted',
            sessionId: msg.sessionId,
          });
        }
        break;
      }

      case 'recorder_start': {
        const instanceId = state.instanceId;
        if (instanceId == null) {
          // Sidepanel never sent its instanceId — reject so we never start
          // a recording we couldn't gate stop() on later.
          safePost(port, {
            type: 'recorder_start_rejected',
            reason: 'before_hello',
          });
          break;
        }
        const currentOwner = recorder.getInitiatorPort();
        if (currentOwner != null && currentOwner !== port) {
          // Another instance already owns the recording. Tell the
          // requesting client so it can toast "another window is
          // recording" instead of silently doing nothing.
          safePost(port, {
            type: 'recorder_start_rejected',
            reason: 'busy',
          });
          break;
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
          safePost(port, {
            type: 'recorder_start_rejected',
            reason: 'busy',
          });
          break;
        }
        await recorder.start({ port, instanceId, initialWindowId });
        break;
      }

      case 'recorder_stop': {
        if (recorder.getInitiatorPort() !== port) {
          // Only the initiator instance's port may stop. Ignore from
          // other instances so a stale UI can't kill a sibling's recording.
          break;
        }
        // Don't send `recorder_session` from here — the `onRecordingFinished`
        // listener wired above does that uniformly for manual stop and
        // cap-trigger auto-stop alike.
        await recorder.stop({ discard: false });
        break;
      }

      case 'hello': {
        // First message after connect: the sidepanel tells us its unique
        // per-instance id. Used to gate recorder_start/stop and to
        // distinguish 'owned' vs 'foreign' on the client.
        state.instanceId = msg.instanceId;
        break;
      }

      case 'mcp_read_resource': {
        // Fetch a `ui://...` UI resource for an MCP App iframe. Reply goes
        // back to the requesting port only (not broadcast) — each iframe
        // owns its own pending read keyed by `requestId`. Errors are
        // classified into two coarse buckets so the sidepanel can render
        // an appropriate fallback without parsing strings.
        const { requestId, serverId, uri } = msg;
        const manager = getMCPManager();
        try {
          // Pre-check disambiguates "server gone" from "fetch failed".
          // Without it, the same `Error("MCP server disabled: ...")` from
          // MCPManager would mask both cases.
          const enabled = await manager.getEnabledServers();
          if (!enabled.some(s => s.id === serverId)) {
            safePost(port, {
              type: 'mcp_resource_result',
              requestId,
              error: {
                code: 'server_unavailable',
                message: `MCP server is not enabled or no longer registered`,
              },
            });
            break;
          }
          const result = await manager.readResource(serverId, uri);
          safePost(port, { type: 'mcp_resource_result', requestId, result });
        } catch (err: any) {
          const message = err?.message ?? String(err);
          // Re-map the narrow race where the user disables / removes the
          // server between the pre-check and `readResource`. The MCPManager
          // throws `MCP server disabled: ...` / `MCP server not registered: ...`
          // for these — string-match is brittle but matches the rest of this
          // file's error-classification style.
          const isServerGone =
            message.startsWith('MCP server disabled:') ||
            message.startsWith('MCP server not registered:');
          safePost(port, {
            type: 'mcp_resource_result',
            requestId,
            error: {
              code: isServerGone ? 'server_unavailable' : 'fetch_failed',
              message,
            },
          });
        }
        break;
      }
    }
  }

  // ─── Skill index invalidation listener ───

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'invalidate_skill_index') {
      invalidateSkillIndex();
      return false;
    }
    if (msg?.type === 'mcp_status') {
      // One-shot status query for the Settings UI. Returns a map keyed by
      // server id, only for currently-enabled servers (disabled ones never
      // connect, so the UI handles them via `!server.enabled` first).
      void (async () => {
        try {
          const mgr = getMCPManager();
          const servers = await mgr.getEnabledServers();
          const out: Record<string, { connected: boolean; breaker: string }> = {};
          for (const s of servers) {
            const st = await mgr.getStatus(s.id);
            if (st) out[s.id] = { connected: st.connected, breaker: st.breaker };
          }
          sendResponse(out);
        } catch (err) {
          console.warn('[background] mcp_status query failed:', err);
          sendResponse({});
        }
      })();
      return true; // async response
    }
    return false;
  });
});

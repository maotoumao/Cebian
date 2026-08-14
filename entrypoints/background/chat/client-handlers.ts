// chat 域的客户端消息 handler：会话订阅 / 发送 / 取消 / 重试 / 工具与授权裁决 /
// 历史列表与删除，以及「最后一个 viewer 断连后延迟取消 agent」的 grace-cancel 策略。
//
// grace-cancel 住在这里而不是 `viewers.ts`：viewers 只放路由状态与投递，若它自己调
// `sessionManager.cancel()` 会与 session-manager 成运行时环（session-manager 广播要经
// viewers）。handler 层没有这个问题 —— session-manager 不 import 本文件。

import { sessionManager } from './session-manager';
import { sessionStore } from './session-store';
import { setViewing, stopViewing, hasViewer } from './viewers';
import { registerClientHandlers, type ClientHandlerMap } from '../ipc/client-router';
import { onPortDisconnect, post, broadcastAll } from '../ipc/port-registry';
import { vfs } from '@/lib/persistence/vfs';
import { isValidSessionId } from '@/lib/utils';

// ─── Grace cancel ───

/**
 * Grace period after the last viewer of a session disconnects before the
 * agent is cancelled. Lets the user close the sidepanel briefly (switch tabs,
 * copy text, navigate away) without killing an in-flight response.
 *
 * The agent's keepalive (`SessionManager.updateKeepAlive`) prevents the SW
 * from being terminated while `isRunning === true`, so the timer is
 * guaranteed to fire as long as the agent is still working.
 */
const AGENT_GRACE_PERIOD_MS = 60_000;

/**
 * Pending grace cancels keyed by sessionId. When the last viewer
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
    // Defensive: the viewer table is the source of truth. In a single-threaded
    // SW runtime `clearTimeout` reliably cancels a pending timer, so this
    // check normally always passes — but it costs nothing to verify.
    if (!hasViewer(sessionId)) {
      sessionManager.cancel(sessionId).catch(err =>
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

// ─── Handlers ───

const chatClientHandlers: ClientHandlerMap = {
  async subscribe(port, msg) {
    setViewing(port, msg.sessionId);
    // A new viewer arrived — cancel any pending grace timer for this
    // session so we don't kill an agent that's about to be observed again.
    cancelGrace(msg.sessionId);
    // Send current agent state if the agent is running for this session
    if (sessionManager.getSessionState(msg.sessionId)) {
      // Title isn't part of the in-memory agent state — load it from DB
      // so the new viewer's header can show the session title even when
      // (re)subscribing mid-stream.
      const session = await sessionStore.load(msg.sessionId);
      // Re-snapshot AFTER the await: during the DB load the agent could
      // have emitted message_update / agent_end and broadcastToViewers()
      // already forwarded those to this port (we registered it as a viewer
      // above). Posting an older snapshot here would regress the hook's
      // `messages` state.
      const fresh = sessionManager.getSessionState(msg.sessionId);
      if (fresh) {
        post(port, {
          type: 'session_state',
          sessionId: msg.sessionId,
          title: session?.title ?? '',
          provider: session?.provider ?? '',
          model: session?.model ?? '',
          thinkingLevel: session?.thinkingLevel ?? '',
          messages: fresh.messages,
          isRunning: fresh.isRunning,
          isCompacting: fresh.isCompacting,
          pendingTools: fresh.pendingTools,
          pendingPermissions: fresh.pendingPermissions,
        });
      } else {
        // Agent finished during the await — fall through to DB-based
        // session_loaded using the row we already loaded.
        post(port, {
          type: 'session_loaded',
          sessionId: msg.sessionId,
          session: session ?? null,
        });
      }
    } else {
      // Agent not running — load from DB. Session not found → session: null.
      const session = await sessionStore.load(msg.sessionId);
      post(port, {
        type: 'session_loaded',
        sessionId: msg.sessionId,
        session: session ?? null,
      });
    }
  },

  unsubscribe(port) {
    stopViewing(port);
  },

  prompt(port, msg) {
    const sessionId = msg.sessionId ?? crypto.randomUUID();
    setViewing(port, sessionId);
    // Start the agent (async — events will be broadcast).
    // For new sessions, sessionManager.prompt() persists the session and
    // broadcasts 'session_created' before starting, so the client can
    // navigate to /chat/<id> immediately.
    // model / thinkingLevel 是本轮携带的「该会话所用模型 / 思考档」，透传给
    // prompt() 作 override（B1：会话行是真相，全局仅作新对话种子）。
    sessionManager.prompt(sessionId, msg.text, msg.attachments, {
      model: msg.model,
      thinkingLevel: msg.thinkingLevel,
    }).catch((err) => {
      post(port, {
        type: 'error',
        sessionId,
        error: err.message ?? String(err),
      });
    });
  },

  cancel(_port, msg) {
    // User-initiated cancel — immediate, no grace period.
    cancelGrace(msg.sessionId);
    sessionManager.cancel(msg.sessionId).catch(err =>
      console.warn(`[cancel] agent cancel failed for ${msg.sessionId}:`, err),
    );
  },

  retry(port, msg) {
    // Re-run the last user turn. Errors propagate via the `error`
    // ServerMessage just like `prompt` so the sidepanel can surface
    // "no user message found" / "agent already running" / model setup
    // failures consistently.
    setViewing(port, msg.sessionId);
    // 同 prompt：透传本轮重试携带的 model / thinkingLevel 作 override。
    sessionManager.retry(msg.sessionId, {
      model: msg.model,
      thinkingLevel: msg.thinkingLevel,
    }).catch((err) => {
      post(port, {
        type: 'error',
        sessionId: msg.sessionId,
        error: err.message ?? String(err),
      });
    });
  },

  resolve_tool(_port, msg) {
    sessionManager.resolveTool(msg.sessionId, msg.toolName, msg.response);
  },

  cancel_tool(_port, msg) {
    sessionManager.cancelTool(msg.sessionId, msg.toolName);
  },

  resolve_permission(_port, msg) {
    sessionManager.resolvePermission(msg.sessionId, msg.toolCallId, msg.decision);
  },

  async session_list(port) {
    const sessions = await sessionStore.list();
    // Annotate with live running state so the UI can show an indicator
    // for sessions whose agent is currently mid-stream in the background.
    const annotated = sessions.map(s => ({
      ...s,
      isRunning: sessionManager.getSessionState(s.id)?.isRunning === true,
    }));
    post(port, {
      type: 'session_list_result',
      sessions: annotated,
    });
  },

  async session_delete(_port, msg) {
    // Validate sessionId before any path construction. The handler is a
    // message boundary that must not trust client input — interpolating
    // a malicious value (empty, `..`, `/etc`, `a/../b`) into the path
    // would let `vfs.rm({recursive:true})` escape `/workspaces/` and
    // wipe `/`, `/home`, or `~/.cebian/` (skills + prompts).
    // Lock to the shape of `crypto.randomUUID()`.
    if (!isValidSessionId(msg.sessionId)) {
      console.warn('[session_delete] rejecting non-UUID sessionId:', msg.sessionId);
      return;
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
    sessionManager.destroySession(msg.sessionId);
    // Broadcast deletion to all connected ports
    broadcastAll({
      type: 'session_deleted',
      sessionId: msg.sessionId,
    });
  },
};

/**
 * 注册 chat 域 handler，并接上断连策略：viewer 出表后若该会话再无人观看，
 * 调度 grace-cancel（而非立即取消），让「关掉侧边栏又马上打开」不打断流式回复。
 * 注意只有**断连**走这条；`unsubscribe` 同样调 `stopViewing`，但用户还在（只是换了
 * 页面），不触发 grace-cancel。
 *
 * 在 `index.ts` 启动序列里、`setupPortRegistry()` 之前同步调用。
 */
function setupChatClientHandlers(): void {
  registerClientHandlers(chatClientHandlers);

  onPortDisconnect((port) => {
    const sessionId = stopViewing(port);
    if (sessionId && !hasViewer(sessionId)) {
      scheduleGraceCancel(sessionId);
    }
  });
}

// ─── 公开 API ───

export { setupChatClientHandlers, chatClientHandlers };

// chat 域的客户端消息 handler：会话订阅 / 发送 / 取消 / 重试 / 工具与授权裁决 /
// 历史列表、删除、分叉与改名，以及「最后一个 viewer 断连后延迟取消 agent」的 grace-cancel 策略。
//
// grace-cancel 住在这里而不是 `viewers.ts`：viewers 只放路由状态与投递，若它自己调
// `sessionManager.cancel()` 会与 session-manager 成运行时环（session-manager 广播要经
// viewers）。handler 层没有这个问题 —— session-manager 不 import 本文件。

import { sessionManager } from './session-manager';
import { sessionStore, type LoadedSession } from './session-store';
import type { SessionSnapshot } from '@/lib/ipc/protocol';
import { setViewing, stopViewing, hasViewer } from './viewers';
import { flushStreamOps } from './stream-broadcast';
import { registerClientHandlers, type ClientHandlerMap } from '../ipc/client-router';
import { onPortDisconnect, post, broadcastAll } from '../ipc/port-registry';
import { vfs } from '@/lib/persistence/vfs';
import { workspaceRootForSession } from '@/lib/persistence/vfs-paths';
import { normalizeSessionTitle } from '@/lib/agent/session-title';
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

/** 冷加载的会话行 → `session_loaded` 快照：给 transcript 附上逐位对齐的树 entryId
 *  （消息编辑按它定位）。副本，不改 record 本体。 */
function toSessionSnapshot(loaded: LoadedSession): SessionSnapshot {
  return {
    ...loaded.record,
    messages: loaded.record.messages.map((m, i) => {
      const entryId = loaded.entryIds[i];
      return entryId !== undefined ? { ...m, entryId } : m;
    }),
    branchInfo: loaded.branchInfo,
  };
}

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
      const loaded = await sessionStore.open(msg.sessionId);
      // 分支信息按活 agent 的当前分支现算（loaded 的快照可能已被在途轮甩开）。
      // 它是本函数最后一个悬挂点，必须先于快照取样——见下
      const branchInfo = await sessionManager.getBranchInfo(msg.sessionId).catch(() => undefined);
      // 快照必须在**所有 await 之后**同步取样、取样与 post 之间不再悬挂：
      // 上面 setViewing 后本 port 已在收流式广播，任何夹在取样与 post 之间
      // 的 await 都可能让先送达的新帧被这份旧快照回退。
      // 取样前先把待发的增量帧 flush 出去（见 flushStreamOps 注释）：快照
      // 已包含这些增量，若留在缓冲里，快照之后到期的 trailing 帧会把同一
      // 段增量对着快照重复应用。flush → 取样全程同步，中间不会混入新事件
      flushStreamOps(msg.sessionId);
      const fresh = sessionManager.getSessionState(msg.sessionId);
      if (fresh) {
        post(port, {
          type: 'session_state',
          sessionId: msg.sessionId,
          title: loaded?.record.title ?? '',
          provider: loaded?.record.provider ?? '',
          model: loaded?.record.model ?? '',
          thinkingLevel: loaded?.record.thinkingLevel ?? '',
          messages: fresh.messages,
          isRunning: fresh.isRunning,
          isCompacting: fresh.isCompacting,
          pendingTools: fresh.pendingTools,
          pendingPermissions: fresh.pendingPermissions,
          ...(branchInfo !== undefined ? { branchInfo } : {}),
        });
      } else {
        // Agent finished during the await — fall through to DB-based
        // session_loaded using the snapshot we already loaded.
        post(port, {
          type: 'session_loaded',
          sessionId: msg.sessionId,
          session: loaded ? toSessionSnapshot(loaded) : null,
        });
      }
    } else {
      // Agent not running — load from DB. Session not found → session: null.
      const loaded = await sessionStore.open(msg.sessionId);
      post(port, {
        type: 'session_loaded',
        sessionId: msg.sessionId,
        session: loaded ? toSessionSnapshot(loaded) : null,
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
    }, msg.slashPrompt).catch((err) => {
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
    // 同 prompt：透传本轮重试携带的 model / thinkingLevel 作 override；
    // entryId 指定要重试的轮（缺省 = 最后一轮）。
    sessionManager.retry(msg.sessionId, {
      model: msg.model,
      thinkingLevel: msg.thinkingLevel,
    }, msg.entryId).catch((err) => {
      post(port, {
        type: 'error',
        sessionId: msg.sessionId,
        error: err.message ?? String(err),
      });
    });
  },

  edit_message(port, msg) {
    // 编辑已发送的 user 消息并从该点重新生成（issue #44）。错误经 `error`
    // ServerMessage 冒泡，与 prompt / retry 一致。
    setViewing(port, msg.sessionId);
    sessionManager.editMessage(msg.sessionId, msg.entryId, msg.text, {
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

  switch_branch(port, msg) {
    // 切换分支：后台 moveLane + 重投影，结果经 session_state（带 branchInfo）广播。
    setViewing(port, msg.sessionId);
    sessionManager.switchBranch(msg.sessionId, msg.targetEntryId).catch((err) => {
      post(port, {
        type: 'error',
        sessionId: msg.sessionId,
        error: err.message ?? String(err),
      });
    });
  },

  async session_list(port) {
    // 自己接住失败并走专用回复：交给 router 的通用 error 会被聊天视图当成本轮对话
    // 出错（清运行态 + 弹错误条），而拉列表跟正在进行的对话没有任何关系。
    try {
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
    } catch (err) {
      post(port, {
        type: 'session_list_error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * 删除一个或多个会话。逐个串行处理而非并发：每条都要动 VFS 与 Dexie 事务，一起放出去
   * 只会互相抢锁，各自的 `destroySession` / grace timer 副作用也该彼此隔离。
   *
   * 单条失败不影响其余：整条 handler 抛出会让 router 回一个通用 error，而已经删掉的
   * 那些得不到广播，UI 就会显示出一份与库不符的列表。但失败也**不能**只写日志——客户端
   * 是乐观删除的，咽掉错误会让一条其实还在的会话从界面上永久消失，故失败的 id 单独回
   * 给发起方，由它把列表拉回来。
   */
  async session_delete(port, msg) {
    const deleted: string[] = [];
    const failed: string[] = [];
    let lastError = '';
    for (const sessionId of msg.sessionIds) {
      // Validate sessionId before any path construction. The handler is a
      // message boundary that must not trust client input — interpolating
      // a malicious value (empty, `..`, `/etc`, `a/../b`) into the path
      // would let `vfs.rm({recursive:true})` escape `/workspaces/` and
      // wipe `/`, `/home`, or `~/.cebian/` (skills + prompts).
      // Lock to the shape of `crypto.randomUUID()`. 批量下逐条校验——一条脏 id
      // 不能让整批过关，也不该让整批失败。
      if (!isValidSessionId(sessionId)) {
        console.warn('[session_delete] rejecting non-UUID sessionId:', sessionId);
        failed.push(sessionId);
        lastError = 'invalid session id';
        continue;
      }
      try {
        // Cancel any pending grace timer — the session is going away.
        cancelGrace(sessionId);
        // Best-effort workspace cleanup. `vfs.rm({force:true})` already
        // tolerates ENOENT, so no exists pre-check is needed. Tolerate any
        // other VFS error and continue with DB deletion — a leaked workspace
        // is recoverable via the VFS browser; an orphan session row would
        // be more confusing.
        const workspacePath = workspaceRootForSession(sessionId);
        try {
          await vfs.rm(workspacePath, { recursive: true, force: true });
        } catch (err) {
          console.warn(`[session_delete] failed to remove workspace ${workspacePath}:`, err);
        }
        await sessionStore.delete(sessionId);
        deleted.push(sessionId);
        // 库里已经删掉了 = 这条就算删成功。内存态清理单独隔离，免得它出错把一次
        // 真实的删除误报成失败（下面会据 deleted / failed 分别广播与回报）。
        try {
          sessionManager.destroySession(sessionId);
        } catch (err) {
          console.warn(`[session_delete] failed to tear down agent for ${sessionId}:`, err);
        }
      } catch (err) {
        console.warn(`[session_delete] failed to delete ${sessionId}:`, err);
        failed.push(sessionId);
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    // Broadcast deletion to all connected ports
    if (deleted.length > 0) broadcastAll({ type: 'session_deleted', sessionIds: deleted });
    if (failed.length > 0) {
      post(port, { type: 'session_write_failed', op: 'delete', sessionIds: failed, error: lastError });
    }
  },

  /**
   * 设置会话在历史列表里的位置（置顶 / 归档 / 普通）。一条消息覆盖四个动作，互斥由
   * `updateSessionPlacement` 这个唯一写入点保证。
   *
   * 不碰工作区、不动活 agent——这只是列表怎么摆，与会话内容无关。
   *
   * 写库是单条 Dexie `.modify()`，整批同生共死，故无需像删除那样逐条隔离。但同样要
   * 自己接住失败：交给 router 的通用 error 既会被聊天视图误当成本轮对话出错，也无法
   * 让发起方撤销它已经做过的乐观更新。
   */
  async session_set_placement(port, msg) {
    // 非法 id 与写失败一样要回报（而非只记日志）：发起方是乐观更新的，被悄悄丢掉的
    // id 会让它的界面停在一个从未落库的状态上。与 session_delete 的处理保持一致。
    const ids: string[] = [];
    const invalid: string[] = [];
    for (const id of msg.sessionIds) {
      if (isValidSessionId(id)) {
        ids.push(id);
      } else {
        console.warn('[session_set_placement] rejecting non-UUID sessionId:', id);
        invalid.push(id);
      }
    }
    if (ids.length > 0) {
      try {
        await sessionStore.updatePlacement(ids, msg.placement);
        broadcastAll({
          type: 'session_placement_changed',
          sessionIds: ids,
          placement: msg.placement,
        });
      } catch (err) {
        console.warn('[session_set_placement] failed:', err);
        invalid.push(...ids);
        post(port, {
          type: 'session_write_failed',
          op: 'placement',
          sessionIds: invalid,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }
    if (invalid.length > 0) {
      post(port, {
        type: 'session_write_failed',
        op: 'placement',
        sessionIds: invalid,
        error: 'invalid session id',
      });
    }
  },

  /**
   * 从一条 assistant 消息处分叉出新会话（issue #60）。顺序：建新会话（树路径复制）→
   * best-effort 复制工作区 → 回 `session_forked`。
   *
   * 工作区复制失败不让分叉失败：会话行与树已落库，此时报错会让用户以为没分叉成功、
   * 再点一次得到两个副本；缺文件是可恢复的（VFS 浏览器可见），与 session_delete 对
   * 工作区清理的 best-effort 口径一致。不动源会话的活 agent：fork 不改源树，源会话
   * 运行中也可分叉。
   */
  async session_fork(port, msg) {
    const { sessionId, entryId } = msg;
    const fail = (error: string) =>
      post(port, { type: 'session_fork_failed', sourceSessionId: sessionId, error });

    // entryId 也要校验：`createForkMutations` 对缺省的 entryId 会退到「分叉整条当前分支」，
    // 畸形载荷不能悄悄变成另一种语义。
    if (!isValidSessionId(sessionId) || typeof entryId !== 'string' || entryId === '') {
      console.warn('[session_fork] rejecting malformed request:', sessionId, entryId);
      fail('invalid session or entry id');
      return;
    }
    let forked: { id: string; title: string };
    try {
      forked = await sessionStore.fork(sessionId, entryId);
    } catch (err) {
      console.warn('[session_fork] failed:', err);
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
    const srcWorkspace = workspaceRootForSession(sessionId);
    const dstWorkspace = workspaceRootForSession(forked.id);
    try {
      await vfs.copyDir(srcWorkspace, dstWorkspace);
    } catch (err) {
      console.warn(`[session_fork] failed to copy workspace ${srcWorkspace} → ${dstWorkspace}:`, err);
    }
    post(port, { type: 'session_forked', sessionId: forked.id, title: forked.title });
  },

  /**
   * 改会话标题（页头 / 历史面板共用）。归一化在后台做：空标题视为非法而不是回退默认
   * 标题——UI 已把「清空」当取消，这里是纵深防御。失败只回发起端口 `session_write_failed`
   * 让它撤销乐观更新；成功广播 `session_renamed`，别的窗口跟着改。不动 updatedAt。
   */
  async session_rename(port, msg) {
    const { sessionId } = msg;
    const fail = (error: string) =>
      post(port, { type: 'session_write_failed', op: 'rename', sessionIds: [sessionId], error });

    if (!isValidSessionId(sessionId)) {
      console.warn('[session_rename] rejecting non-UUID sessionId:', sessionId);
      fail('invalid session id');
      return;
    }
    const title = typeof msg.title === 'string' ? normalizeSessionTitle(msg.title) : null;
    if (!title) {
      fail('invalid title');
      return;
    }
    try {
      if (!(await sessionStore.rename(sessionId, title))) {
        fail('session not found');
        return;
      }
    } catch (err) {
      console.warn('[session_rename] failed:', err);
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
    broadcastAll({ type: 'session_renamed', sessionId, title });
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

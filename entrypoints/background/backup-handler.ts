// 备份相关的 background 响应器。
//
// 仅此一文件负责 backup IPC。会话存 Dexie，而 background 是其唯一**写者**（消除多
// sidepanel 并发写冲突 + 保证替换模式「清空后写入」的事务原子性），所以会话**写回**
// 必须经这里转一手（见 lib/backup/sources/sessions.ts 的 wire 契约）。
//
// 采集（读）已改为页面侧直读同源 Dexie，不再经 background——本文件对读这条线只提供一个
// 无 payload 的 flush 信号，把在途的节流写刷落库，让页面随后直读时不漏最新消息。
//
// 写回（恢复）走分块协议：页面按字节预算把 records 切批，逐批 CHUNK 累积进一个按 nonce
// 隔离的缓冲，最后 COMMIT 一次性在单事务里写入——避免一条巨大的 runtime message 撞
// Chrome 的 64MiB 上限。半截缓冲由 ABORT 或 TTL 超时清理，杜绝内存泄漏。
//
// VFS 与 storage.local 在扩展页面同源可直接读写，不经 background——因此本文件
// 只处理会话这一条线。

import { sessionStore } from './session-store';
import {
  BACKUP_FLUSH_SESSIONS,
  BACKUP_APPLY_CHUNK,
  BACKUP_APPLY_COMMIT,
  BACKUP_APPLY_ABORT,
  type BackupResponse,
  type ApplySessionsResult,
} from '@/lib/backup/sources/sessions';
import { toSessionRecord, isValidSessionLike, type SessionRecord, type SessionRecordLike } from '@/lib/persistence/db';

/** 统一把异步结果包成响应信封发回，错误转成可读字符串（页面侧据此重新抛出）。 */
function respond<T>(
  produce: () => Promise<T>,
  sendResponse: (resp: BackupResponse<T>) => void,
): true {
  void (async () => {
    try {
      const value = await produce();
      sendResponse({ ok: true, value });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      sendResponse({ ok: false, error });
    }
  })();
  // 异步响应
  return true;
}

// ─── 分块恢复的 nonce 暂存机 ───
//
// 每次恢复在页面侧生成一个一次性 nonce，把同一次恢复的多个 chunk 与随后的 commit 关联
// 起来。background 按 nonce 在 Map 里隔离各自的累积缓冲：多窗口并发恢复互不串扰，每个
// commit 只消费自己 nonce 的缓冲。半截缓冲（页面中途崩溃 / 关闭，只发了一部分 chunk）由
// 一个 TTL 计时器兜底清理，避免永久占内存。

/** 单个 nonce 的累积缓冲。`records` 已逐条 toSessionRecord 规整。 */
interface ApplyBuffer {
  records: SessionRecord[];
  timer: ReturnType<typeof setTimeout>;
}

/** 缓冲存活上限：超过此时长无新 chunk / 未 commit，则丢弃。覆盖页面崩溃 / 关闭导致的
 *  孤儿缓冲。正常恢复在此窗口内会持续 chunk 或很快 commit，不会被误清。 */
const APPLY_BUFFER_TTL_MS = 60_000;

const applyBuffers = new Map<string, ApplyBuffer>();

/** 丢弃某 nonce 的缓冲并清掉其 TTL 计时器（commit 成功、abort、或超时时调用）。 */
function dropBuffer(nonce: string): void {
  const buf = applyBuffers.get(nonce);
  if (!buf) return;
  clearTimeout(buf.timer);
  applyBuffers.delete(nonce);
}

/** 取得（或新建）某 nonce 的缓冲，并重置其 TTL 计时器。每收到一个 chunk 都刷新存活窗口，
 *  让正在持续发送的恢复不被超时误清。 */
function touchBuffer(nonce: string): ApplyBuffer {
  let buf = applyBuffers.get(nonce);
  if (buf) {
    clearTimeout(buf.timer);
  } else {
    buf = { records: [], timer: undefined as unknown as ReturnType<typeof setTimeout> };
    applyBuffers.set(nonce, buf);
  }
  buf.timer = setTimeout(() => dropBuffer(nonce), APPLY_BUFFER_TTL_MS);
  return buf;
}

/** 注册备份 IPC 响应器。在 background 入口调用一次。 */
export function registerBackupHandler(): void {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const isBackup =
      msg?.type === BACKUP_FLUSH_SESSIONS ||
      msg?.type === BACKUP_APPLY_CHUNK ||
      msg?.type === BACKUP_APPLY_COMMIT ||
      msg?.type === BACKUP_APPLY_ABORT;
    // 非 backup 消息，交给其它监听器
    if (!isBackup) return false;

    // 破坏性 backup 操作只允许扩展自身页面 / SW 发起。content script 注入在标签页
    // 里时 sender.tab 非空——拒绝，避免页面脚本触发刷写 / 累积 / 写回会话。
    if (sender.tab != null) {
      sendResponse({ ok: false, error: 'backup messages are not allowed from tab contexts' });
      return true;
    }

    // flush：把在途节流写刷落库，供页面随后直读 Dexie 采集。无 payload、无返回值。
    if (msg.type === BACKUP_FLUSH_SESSIONS) {
      return respond<void>(() => sessionStore.flushAll(), sendResponse);
    }

    // chunk：校验并规整这一批 records，累积进对应 nonce 的缓冲。逐条 isValidSessionLike
    // 守卫（坏了就拒整批）后 toSessionRecord 补默认 + 重算 messageCount，保证最终写库
    // 形态完整。重置 TTL 计时器。
    if (msg.type === BACKUP_APPLY_CHUNK) {
      return respond<void>(async () => {
        if (typeof msg.nonce !== 'string' || msg.nonce === '') {
          throw new Error('applyChunk: missing nonce');
        }
        if (!Array.isArray(msg.records)) {
          throw new Error('applyChunk: records must be an array');
        }
        if (!msg.records.every(isValidSessionLike)) {
          throw new Error('applyChunk: malformed session record in payload');
        }
        const buf = touchBuffer(msg.nonce);
        for (const r of msg.records as SessionRecordLike[]) {
          buf.records.push(toSessionRecord(r));
        }
      }, sendResponse);
    }

    // commit：取出 nonce 缓冲，校验累积条数 === 页面声明的 expectedCount（不符说明有
    // chunk 丢失 / 被超时清理 → 拒绝写入，绝不在替换模式下清空本地却只恢复一部分），
    // 再交 applyAll 单事务写回。无论成功失败都丢弃缓冲。
    if (msg.type === BACKUP_APPLY_COMMIT) {
      return respond<ApplySessionsResult>(async () => {
        if (typeof msg.nonce !== 'string' || msg.nonce === '') {
          throw new Error('applyCommit: missing nonce');
        }
        if (typeof msg.expectedCount !== 'number' || !Number.isInteger(msg.expectedCount) || msg.expectedCount < 0) {
          throw new Error(`applyCommit: invalid expectedCount ${String(msg.expectedCount)}`);
        }
        // 空恢复（expectedCount === 0）时页面不发任何 chunk，故无缓冲——这是合法的：
        // 替换模式下用空集 applyAll 会清空本地会话。非空却无缓冲才是错误（过期 / 已提交）。
        const buf = applyBuffers.get(msg.nonce);
        try {
          if (msg.strategy !== 'merge' && msg.strategy !== 'replace') {
            throw new Error(`applyCommit: invalid strategy ${String(msg.strategy)}`);
          }
          if (!buf) {
            if (msg.expectedCount !== 0) {
              throw new Error('applyCommit: no buffered records for nonce (expired or already committed)');
            }
            return await sessionStore.applyAll([], msg.strategy);
          }
          if (buf.records.length !== msg.expectedCount) {
            throw new Error(
              `applyCommit: expected ${msg.expectedCount} records but buffered ${buf.records.length}`,
            );
          }
          return await sessionStore.applyAll(buf.records, msg.strategy);
        } finally {
          // 仅在确有缓冲时清理（空恢复路径压根没建缓冲）。成功失败都丢弃。
          if (buf) dropBuffer(msg.nonce);
        }
      }, sendResponse);
    }

    // abort：发送中途失败时清理半截缓冲。无返回值；nonce well-formed 但不存在也算成功
    // （幂等）；缺失 / 非串 nonce 是协议错误，拒绝以暴露客户端 bug。
    return respond<void>(async () => {
      if (typeof msg.nonce !== 'string' || msg.nonce === '') {
        throw new Error('applyAbort: missing nonce');
      }
      dropBuffer(msg.nonce);
    }, sendResponse);
  });
}

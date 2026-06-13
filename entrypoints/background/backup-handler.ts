// 备份相关的 background 响应器。
//
// 仅此一文件负责 backup IPC：会话采集 / 写回。会话存 Dexie，而 background 是其
// 唯一读写者，所以页面侧的 collect / restore 必须经这里转一手（见
// lib/backup/sources/sessions.ts 的 wire 契约）。
//
// VFS 与 storage.local 在扩展页面同源可直接读写，不经 background——因此本文件
// 只处理会话这一条线。

import { sessionStore } from './session-store';
import {
  BACKUP_COLLECT_SESSIONS,
  BACKUP_APPLY_SESSIONS,
  type BackupResponse,
  type ApplySessionsResult,
} from '@/lib/backup/sources/sessions';
import { toSessionRecord, isValidSessionLike, type SessionRecord, type SessionRecordLike } from '@/lib/db';

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

/** 注册备份 IPC 响应器。在 background 入口调用一次。 */
export function registerBackupHandler(): void {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const isBackup =
      msg?.type === BACKUP_COLLECT_SESSIONS || msg?.type === BACKUP_APPLY_SESSIONS;
    // 非 backup 消息，交给其它监听器
    if (!isBackup) return false;

    // 破坏性 backup 操作只允许扩展自身页面 / SW 发起。content script 注入在标签页
    // 里时 sender.tab 非空——拒绝，避免页面脚本触发清空 / 写回会话。
    if (sender.tab != null) {
      sendResponse({ ok: false, error: 'backup messages are not allowed from tab contexts' });
      return true;
    }

    if (msg.type === BACKUP_COLLECT_SESSIONS) {
      return respond<SessionRecord[]>(() => sessionStore.collectAll(), sendResponse);
    }

    // BACKUP_APPLY_SESSIONS
    return respond<ApplySessionsResult>(() => {
      if (!Array.isArray(msg.records)) {
        throw new Error('applySessions: records must be an array');
      }
      if (msg.strategy !== 'merge' && msg.strategy !== 'replace') {
        throw new Error(`applySessions: invalid strategy ${String(msg.strategy)}`);
      }
      // 先按关键字段校验（坏了就拒整次），再逐条规整补默认 + 重算 messageCount，
      // 保证写进 Dexie 的记录形态完整。
      if (!msg.records.every(isValidSessionLike)) {
        throw new Error('applySessions: malformed session record in payload');
      }
      const records = (msg.records as SessionRecordLike[]).map(toSessionRecord);
      return sessionStore.applyAll(records, msg.strategy);
    }, sendResponse);
  });
}

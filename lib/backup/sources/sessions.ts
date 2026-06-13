// 会话（Dexie）这个备份「源」的全部逻辑：IPC 契约、页面侧客户端、纯恢复决策。
//
// 会话存在 Dexie（`cebian` DB），而 background service worker 是其唯一读写者
// （见 entrypoints/background/session-store.ts）。因此备份采集会话、恢复写回会话
// 都必须经 background 走一趟：这里定义 wire 契约 + 页面侧薄客户端，背景侧响应器在
// 背景侧响应器在 entrypoints/background/backup-handler.ts，实际写库决策
// （planSessionWrites）也在本文件、在 background 中由 SessionStore.applyAll 调用。
// 把会话源的采集 + 恢复聚到一处。
//
// 走 chrome.runtime.sendMessage（非 agent port，那是另一条专用通道）。会话记录是
// JSON-safe（无 Uint8Array 等需信封的二进制）。但消息内容里可能含 base64 内联图片
// （见 lib/attachments），完整历史经一次 sendMessage 序列化可能很大。
// TODO（未来）：无界大历史应改为分块 / 分页协议，或由 background 落一份临时
// payload 供页面分块拉取，避免单条 runtime message 过大导致发送失败或内存压力。

import type { SessionRecord } from '@/lib/db';
import type { RestoreStrategy } from '../types';

// ─── IPC 契约 ───

/** 采集全部会话（含消息历史）。 */
export const BACKUP_COLLECT_SESSIONS = 'backup:collectSessions';
/** 按策略把会话写回 Dexie。 */
export const BACKUP_APPLY_SESSIONS = 'backup:applySessions';

export interface CollectSessionsRequest {
  type: typeof BACKUP_COLLECT_SESSIONS;
}

export interface ApplySessionsRequest {
  type: typeof BACKUP_APPLY_SESSIONS;
  records: SessionRecord[];
  strategy: RestoreStrategy;
}

/** 恢复写入结果。 */
export interface ApplySessionsResult {
  /** 实际写入（upsert）的会话数。 */
  written: number;
  /** 合并模式下跳过的会话数。 */
  skipped: number;
  /** 替换模式是否清空了本地会话。 */
  cleared: boolean;
}

/** 响应信封：background 不能跨边界 throw，用 ok/error 让页面侧重新抛出。 */
export type BackupResponse<T> = { ok: true; value: T } | { ok: false; error: string };

async function send<T>(req: CollectSessionsRequest | ApplySessionsRequest): Promise<T> {
  const resp = (await chrome.runtime.sendMessage(req)) as BackupResponse<T> | undefined;
  if (!resp) {
    throw new Error(`Background did not respond to ${req.type}`);
  }
  if (!resp.ok) {
    throw new Error(resp.error);
  }
  return resp.value;
}

// ─── 恢复写入决策（纯逻辑） ───
//
// ─── 写入决策（纯逻辑，仅在 background 使用） ───
//
// 本节是 background 独有逻辑：页面侧只调 restoreSessions 发起恢复，真正「该怎么
// 写 Dexie」的决策由背景层 SessionStore.applyAll 调 planSessionWrites 算出。
// 备份恢复里最关乎数据安全的一条规则——合并模式下「旧备份绝不能覆盖更新的
// 本地会话」。抽成不碰 Dexie 的纯函数，便于单测；真正的 IndexedDB 写入由背景层
// 在一个事务里执行这份计划。

/** 规划会话恢复要做的写入（由 background 消费）。 */
export interface SessionWritePlan {
  /** 需要写入（upsert）的完整会话记录。 */
  toPut: SessionRecord[];
  /** 合并模式下被跳过的会话 id（本地已有同名且不更旧）。 */
  skipped: string[];
  /** 替换模式：写入前先清空全部本地会话。 */
  clearAll: boolean;
}

/** 规划写入时仅需读取本地已有会话的 id 与 updatedAt。 */
export type ExistingSessionMeta = Pick<SessionRecord, 'id' | 'updatedAt'>;

/** 按 id 去重 incoming：同 id 保留 `updatedAt` 最大的一条。备份理论上不该出现重复
 *  id，但若出现（手工拼接 / 损坏包），不去重会让 Dexie bulkPut 由数组顺序而非
 *  updatedAt 决定最终留存，违反 id+updatedAt LWW。 */
function dedupeById(records: SessionRecord[]): SessionRecord[] {
  const byId = new Map<string, SessionRecord>();
  for (const r of records) {
    const prev = byId.get(r.id);
    if (!prev || r.updatedAt > prev.updatedAt) byId.set(r.id, r);
  }
  return [...byId.values()];
}

/**
 * 根据策略规划要写入 / 跳过哪些会话（仅在 background 调用）。incoming 先按 id
 * 去重（保留 updatedAt 最大）。
 *
 * - `replace`：破坏性——清空全部本地会话后照搬备份。`clearAll=true`，`toPut` 为
 *   去重后的全部 incoming。
 * - `merge`：只增不减——对每条 incoming，本地缺失或备份更新（`updatedAt` 更大）
 *   才写入；本地已有且不更旧则跳过。绝不删除本地多出来的会话。相等的 `updatedAt`
 *   视为「本地不更旧」→ 跳过，避免用内容可能不同但时间戳相同的旧备份覆盖本地。
 */
export function planSessionWrites(
  existing: ExistingSessionMeta[],
  incoming: SessionRecord[],
  strategy: RestoreStrategy,
): SessionWritePlan {
  const deduped = dedupeById(incoming);

  if (strategy === 'replace') {
    return { toPut: deduped, skipped: [], clearAll: true };
  }

  const existingUpdatedAt = new Map<string, number>();
  for (const s of existing) existingUpdatedAt.set(s.id, s.updatedAt);

  const toPut: SessionRecord[] = [];
  const skipped: string[] = [];
  for (const rec of deduped) {
    const localUpdatedAt = existingUpdatedAt.get(rec.id);
    if (localUpdatedAt === undefined || rec.updatedAt > localUpdatedAt) {
      toPut.push(rec);
    } else {
      skipped.push(rec.id);
    }
  }
  return { toPut, skipped, clearAll: false };
}

// ─── 源的公开 API（供顶层 collect / restore 编排调用） ───

/** 采集全部会话记录（background 会先 flush 节流写）。「经 background」是实现细节，
 *  调用方无需关心。 */
export function collectSessions(): Promise<SessionRecord[]> {
  return send<SessionRecord[]>({ type: BACKUP_COLLECT_SESSIONS });
}

/** 把会话按策略写回（background 是 Dexie 唯一写者）。 */
export function restoreSessions(
  records: SessionRecord[],
  strategy: RestoreStrategy,
): Promise<ApplySessionsResult> {
  return send<ApplySessionsResult>({ type: BACKUP_APPLY_SESSIONS, records, strategy });
}

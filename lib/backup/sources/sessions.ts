// 会话（Dexie）这个备份「源」的全部逻辑：IPC 契约、页面侧客户端、纯恢复决策。
//
// 会话存在 Dexie（`cebian` DB）。Dexie 是同源 IndexedDB，扩展页面可直接打开同一个
// DB **读取**——所以采集（读）在纯前端直读（会话行 + mutation 日志投影），庞大的会话
// 历史不再经消息通道序列化，从根本上避开 Chrome runtime message 的 64MiB 上限
//（issue #14）。唯一需要 background 配合的是：树写可能仍在 background 的串行链上
// 在途，读前先发一个无 payload 的 flush 信号等它落定，避免漏掉最新几条。
//
// 但 background service worker 是 Dexie 的**唯一写者**（见
// entrypoints/background/chat/session-store.ts，消除多 sidepanel 并发写冲突 + 保证替换
// 模式「清空后写入」的事务原子性）。所以恢复（写）仍必须经 background。为避免写回时
// 同样撞 64MiB，恢复改成分块协议：页面按序列化字节预算把 records 切批，逐批
// CHUNK 发给 background 累积进一个按 token 隔离的缓冲，最后 COMMIT 一次性在单事务里
// 写入。背景侧响应器在 entrypoints/background/chat/backup-handler.ts；实际写库决策
// （planSessionWrites）也在本文件、在 background 中由 SessionStore.applyAll 调用。
//
// 走 chrome.runtime.sendMessage（非 agent port，那是另一条专用通道）。会话记录是
// JSON-safe（无 Uint8Array 等需信封的二进制）。

import {
  getSessionMutations,
  listSessions,
  type SessionBackupRecord,
  type SessionRecord,
} from '@/lib/persistence/db';
import { projectMutationLog } from '@/lib/persistence/migrate-messages';
import type { RestoreStrategy } from '../types';

// ─── IPC 契约 ───

/** 让 background 等全部会话的在途树写落定（无 payload）。采集前发，确保页面随后
 *  直读 Dexie 时能读到仍在串行链上的在途消息。 */
export const BACKUP_FLUSH_SESSIONS = 'backup:flushSessions';
/** 恢复分块协议：把一批 records 累积进 background 按 nonce 隔离的缓冲。 */
export const BACKUP_APPLY_CHUNK = 'backup:applyChunk';
/** 恢复分块协议：提交某 nonce 累积的全部 records，单事务写回 Dexie。 */
export const BACKUP_APPLY_COMMIT = 'backup:applyCommit';
/** 恢复分块协议：放弃某 nonce 的缓冲（发送中途失败时清理，避免内存泄漏）。 */
export const BACKUP_APPLY_ABORT = 'backup:applyAbort';

interface FlushSessionsRequest {
  type: typeof BACKUP_FLUSH_SESSIONS;
}

interface ApplyChunkRequest {
  type: typeof BACKUP_APPLY_CHUNK;
  /** 每次恢复生成一次的一性关联值（`crypto.randomUUID`），把同一次恢复的多个
   *  chunk 与随后的 commit 绑在一起；background 据此在 Map 里隔离不同恢复的缓冲。 */
  nonce: string;
  records: SessionRecord[];
}

interface ApplyCommitRequest {
  type: typeof BACKUP_APPLY_COMMIT;
  nonce: string;
  strategy: RestoreStrategy;
  /** 页面声明的 records 总数；background 据此校验累积条数一致，不符则拒绝写入，
   *  挡住「某 chunk 丢失 / 超时被清理后仍 COMMIT」在替换模式下清空本地只恢复一部分。 */
  expectedCount: number;
}

interface ApplyAbortRequest {
  type: typeof BACKUP_APPLY_ABORT;
  nonce: string;
}

type BackupRequest =
  | FlushSessionsRequest
  | ApplyChunkRequest
  | ApplyCommitRequest
  | ApplyAbortRequest;

/** 请求类型 → 响应负载类型的映射：把 wire 契约的请求 / 响应配对绑死，避免
 *  `send<任意类型>(任意请求)` 这种错配编译通过。只有 COMMIT 返回结果，其余是 void。 */
interface BackupResultMap {
  [BACKUP_FLUSH_SESSIONS]: void;
  [BACKUP_APPLY_CHUNK]: void;
  [BACKUP_APPLY_COMMIT]: ApplySessionsResult;
  [BACKUP_APPLY_ABORT]: void;
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

async function send<R extends BackupRequest>(req: R): Promise<BackupResultMap[R['type']]> {
  type T = BackupResultMap[R['type']];
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

/** 规划会话恢复要做的写入（由 background 消费）。泛型 R：计划只读 id/updatedAt
 *  做决策，records 原样透传——恢复线格式（SessionBackupRecord，可能带 mutations
 *  日志）经计划流到执行层不丢字段。 */
export interface SessionWritePlan<R extends ExistingSessionMeta = SessionRecord> {
  /** 需要写入（upsert）的完整会话记录。 */
  toPut: R[];
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
function dedupeById<R extends ExistingSessionMeta>(records: R[]): R[] {
  const byId = new Map<string, R>();
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
export function planSessionWrites<R extends ExistingSessionMeta>(
  existing: ExistingSessionMeta[],
  incoming: R[],
  strategy: RestoreStrategy,
): SessionWritePlan<R> {
  const deduped = dedupeById(incoming);

  if (strategy === 'replace') {
    return { toPut: deduped, skipped: [], clearAll: true };
  }

  const existingUpdatedAt = new Map<string, number>();
  for (const s of existing) existingUpdatedAt.set(s.id, s.updatedAt);

  const toPut: R[] = [];
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

// ─── 分块发送（恢复写回） ───

/** 单批 records 预算（按 `JSON.stringify(...).length`，即 UTF-16 码元数估算）。取
 *  20MiB：`.length` 最坏会低估真实 UTF-8 字节 3 倍（一个中文字符 = 1 码元
 *  但 = 3 UTF-8 字节），故 20×3 = 60MiB < 64MiB 的 runtime message 上限，纯中文
 *  会话也安全；base64 内联图片是 ASCII，`.length` 对它准确。不用 TextEncoder 算
 *  真实字节，是为避免对每条记录多跨一次编码的开销；20MiB 预算的 3 倍 gap 已足够
 *  吸收这层差异与消息信封（type/nonce）+ 结构化克隆开销。
 *
 *  物理极限：单条 record 序列化后真实字节若仍 >64MiB（messages 与 mutations 内容
 *  重复、各占一半预算，约合单会话 ~20 张高清图，仍属罕见），分块也无法经 runtime
 *  message 写回——这是消息通道的硬上限，非本协议能解，留作另案。此处仅保证
 *  「单条超预算独占一批」，不把它和别的记录叠加放大问题。 */
const CHUNK_BYTE_BUDGET = 20 * 1024 * 1024;

/** 按序列化字节预算把 records 切成多批：逐条累加 `JSON.stringify(...).length`，超预算
 *  就先 yield 当前批。单条记录无论多大都独占一批（绝不与他人叠加）。空输入不产出任何
 *  批次。 */
export function* chunkBySerializedSize<R>(
  records: R[],
  budget: number,
): Generator<R[]> {
  let batch: R[] = [];
  let batchBytes = 0;
  for (const rec of records) {
    const size = JSON.stringify(rec).length;
    // 当前批非空且加上这条会超预算 → 先发出当前批，再把这条放进新批。
    if (batch.length > 0 && batchBytes + size > budget) {
      yield batch;
      batch = [];
      batchBytes = 0;
    }
    batch.push(rec);
    batchBytes += size;
  }
  if (batch.length > 0) yield batch;
}

// ─── 源的公开 API（供顶层 collect / restore 编排调用） ───

/** 采集全部会话记录。先发 flush 信号等 background 的在途树写落定，再在**页面侧**
 *  直接读同源 Dexie——庞大的会话历史不经 runtime message，从根本上避开 64MiB 上限。
 *
 *  树化后 transcript 的真相在 mutation 日志里（行上的 `messages` 只是 v1 迁移遗留
 *  的冻结影子，新会话根本没有）。每会话导出双份：`messages` = 当前 main 分支投影
 *  （旧版本扩展仍可导入的 v1 形态），`mutations` = 可重放的一致日志前缀（新版本
 *  导入时完整保留分支；坏尾被截掉，避免恢复侧严格校验整体拒绝反而丢光分支）。
 *  迁移失败行（`treeMigrationFailed`，无日志）例外地只导出影子字段——那是它们的真相。 */
export async function collectSessions(): Promise<SessionBackupRecord[]> {
  await send({ type: BACKUP_FLUSH_SESSIONS });
  const rows = await listSessions();
  return Promise.all(
    rows.map(async (row): Promise<SessionBackupRecord> => {
      if (row.treeMigrationFailed) return row;
      const raw = (await getSessionMutations(row.id)).map((r) => r.mutation);
      const { messages, validPrefix } = projectMutationLog(raw);
      return {
        ...row,
        messages,
        ...(validPrefix.length > 0 ? { mutations: validPrefix } : {}),
      };
    }),
  );
}

/** 把会话按策略写回（background 是 Dexie 唯一写者）。按字节预算分块 CHUNK 发送、累积
 *  进 background 一个按 nonce 隔离的缓冲，再 COMMIT 一次性在单事务里写入。任一步失败
 *  best-effort 发 ABORT 丢弃半截缓冲（不掩盖原始错误）。 */
export async function restoreSessions(
  records: SessionBackupRecord[],
  strategy: RestoreStrategy,
): Promise<ApplySessionsResult> {
  const nonce = crypto.randomUUID();
  try {
    for (const batch of chunkBySerializedSize(records, CHUNK_BYTE_BUDGET)) {
      await send({ type: BACKUP_APPLY_CHUNK, nonce, records: batch });
    }
    return await send({
      type: BACKUP_APPLY_COMMIT,
      nonce,
      strategy,
      expectedCount: records.length,
    });
  } catch (err) {
    await send({ type: BACKUP_APPLY_ABORT, nonce }).catch(() => {});
    throw err;
  }
}

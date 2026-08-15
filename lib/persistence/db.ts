import Dexie, { type EntityTable, type Table, type Transaction } from 'dexie';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { asString, isValidSessionId } from '@/lib/utils';
import {
  messagesToMutations,
  sanitizeMutationLog,
  validateMutationLog,
} from '@/lib/persistence/migrate-messages';
import type { SessionMutation } from '@/lib/shims/pi-session-state';
import {
  countMessageEntries,
  mutationSeq,
  SESSION_MUTATIONS_SCHEMA,
  type SessionMutationRow,
  type SessionTreeDb,
} from '@/lib/persistence/session-tree';

// ─── Schema ───

/** `SessionRecord` 的「弱化形态」：只保证身份 / 时间合法、`messages` 是数组（元素形态
 *  未确认）。命名仿 `PromiseLike`——完整的 `SessionRecord` 是它的子类型（`extends`）。
 *  用作 IPC 边界校验（`isValidSessionLike`）后、规整（`toSessionRecord`）前的中间形态：
 *  关键字段已验，描述性字段仍未知。`messages` 故意放宽成 `unknown[]`，不耦合第三方
 *  `AgentMessage` 的内部结构。 */
export interface SessionRecordLike {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: unknown[];
}

// 新增字段时：同步更新下方 `toSessionRecord`（它逐字段构造完整记录）。必填字段漏补会被
// 返回类型 tsc 拦住；但可选字段漏补不会报错、会被静默丢弃，仍需在此显式决定默认值 /
// 透传 / 丢弃。
export interface SessionRecord extends SessionRecordLike {
  title: string;
  model: string;
  provider: string;
  userInstructions: string;
  thinkingLevel: string;
  messageCount: number;
  messages: AgentMessage[];
  /** v1→v2 树化迁移失败的标记：该行的 mutation 日志缺失，原始数据仍在 `messages`
   *  遗留字段，读路径（session-store.open）会懒重试转换。正常行不携带此字段。 */
  treeMigrationFailed?: true;
}

/**
 * 把通过关键字段校验的不可信输入规整成完整 `SessionRecord`。与 `SessionRecord` 同源
 * 维护——加字段时在此逐字段补默认。描述性字段（title / model / provider /
 * userInstructions / thinkingLevel）缺失或类型不对时补安全默认，而非拒绝整条记录。
 * `messageCount` 不信输入、直接重算 `= messages.length`（写库时会随 mutation 日志
 * 重建再精确化为 message entry 数）。`messages` 原样透传，不碰其内部结构（第三方
 * `AgentMessage`，形态会随库演进）。
 */
export function toSessionRecord(input: SessionRecordLike): SessionRecord {
  const s = input as unknown as Record<string, unknown>;
  // `treeMigrationFailed` 有意丢弃：恢复入口拿到的是 v1 messages 形态，写入后会
  // 重新走树化转换，旧库的失败标记不应传染到新库。
  return {
    id: input.id,
    title: asString(s.title, ''),
    model: asString(s.model, ''),
    provider: asString(s.provider, ''),
    userInstructions: asString(s.userInstructions, ''),
    thinkingLevel: asString(s.thinkingLevel, 'medium'),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    messages: input.messages as AgentMessage[],
    messageCount: input.messages.length,
  };
}

/**
 * 会话的备份线格式：`SessionRecord`（`messages` = 当前 main 分支投影，保证旧版本
 * 扩展仍能导入）外加可选的完整 mutation 日志（带上被 retry/编辑留下的全部分支）。
 * 备份采集产出、恢复写回消费；Dexie 行本身**不存** `mutations` 字段（写库前剥离）。
 * 该字段是纯增量扩展，旧版本读取时忽略未知字段即可，故 BACKUP_FORMAT_VERSION 不 bump。
 */
export interface SessionBackupRecord extends SessionRecord {
  mutations?: SessionMutation[];
}

/** 校验一个不可信值是否是合法的 `SessionRecordLike`——身份 / 安全关键字段，错了就说明
 *  来源（备份包 / IPC payload）是坏的，必须拒绝。`id` 要求 UUID 形态（它会成为备份文件名
 *  / 工作区目录段，畸形 id 会污染路径）；时间戳要求有限数字；`messages` 要求数组、且每个
 *  元素是非 null 对象。描述性字段不在此校验，留给 `toSessionRecord` 补默认。
 *
 *  注意：不深入校验 `messages` 内部字段——其元素是第三方 `pi-agent-core` 的 `AgentMessage`，
 *  结构会随库演进，只验「是非 null 对象」以解耦（但这一层守卫必要：`null` / 原始值元素会让
 *  渲染器解引用 msg.role 时整页崩，必须挡在写库前）。
 *
 *  恢复链路两处共用此守卫：page 侧（restore.ts）校验后把畸形记录归为 corruptBackup；
 *  background 侧（backup-handler）作为 IPC 边界的纵深防御。 */
export function isValidSessionLike(r: unknown): r is SessionRecordLike {
  if (!r || typeof r !== 'object') return false;
  const s = r as Record<string, unknown>;
  return (
    typeof s.id === 'string' &&
    isValidSessionId(s.id) &&
    typeof s.createdAt === 'number' &&
    Number.isFinite(s.createdAt) &&
    typeof s.updatedAt === 'number' &&
    Number.isFinite(s.updatedAt) &&
    Array.isArray(s.messages) &&
    s.messages.every((m) => m !== null && typeof m === 'object')
  );
}

// ─── Database ───

const db = new Dexie('cebian') as Dexie & {
  sessions: EntityTable<SessionRecord, 'id'>;
  sessionMutations: Table<SessionMutationRow, [string, number]>;
};

db.version(1).stores({
  sessions: 'id, updatedAt',
});

/** 每批迁移的会话行数：分页游标控制 versionchange 事务内的峰值内存。 */
const TREE_MIGRATION_BATCH = 50;

/**
 * 以一行的 `messages` 为准重建其 mutation 日志（先删旧日志再写，messageCount 同步
 * 重算）。三处共用：v1→v2 upgrade、迁移失败行的懒重试、备份恢复的双写。
 * 必须在已开启的 Dexie 事务内调用（所有操作都是传入表上的 Dexie op）。
 */
async function rebuildSessionTreeLog(
  // 第三泛型放宽为 any：同时接受 upgrade 事务的 tx.table()（TInsertType = T）与
  // 直连的 EntityTable（TInsertType = InsertType<T, 'id'>），仅使用两者共有的方法
  sessions: Table<SessionRecord, string, any>,
  mutationsTable: Table<SessionMutationRow, [string, number], any>,
  row: SessionRecord,
): Promise<void> {
  const mutations = messagesToMutations(Array.isArray(row.messages) ? row.messages : [], row.updatedAt);
  await mutationsTable.where('sessionId').equals(row.id).delete();
  if (mutations.length > 0) {
    await mutationsTable.bulkAdd(
      mutations.map((mutation) => ({ sessionId: row.id, seq: mutationSeq(mutation), mutation })),
    );
  }
  await sessions.update(row.id, { messageCount: countMessageEntries(mutations) });
}

/**
 * 迁移失败行（`treeMigrationFailed`）的懒重试：读行 → 重建日志 → 清标记，单事务。
 * 行不存在或未打标记时为 no-op。失败原样抛出——调用方（session-store.open）
 * 会拒绝打开该会话而不是以空树降级，防止「新消息写进空树、随后重试成功的重建
 * 又把它们删掉」的静默丢失。
 */
export async function retryTreeMigration(id: string): Promise<void> {
  await db.transaction('rw', db.sessions, db.sessionMutations, async () => {
    const row = await db.sessions.get(id);
    if (!row?.treeMigrationFailed) return;
    // 防御：标记未清却已有日志行（理论上不可达——open 在重试失败时会拒开会话，
    // 不存在往空树追加的路径）。重建会删掉这些行造成丢失，宁可报错人工介入。
    const existing = await db.sessionMutations.where('sessionId').equals(id).count();
    if (existing > 0) {
      throw new Error(
        `retryTreeMigration: session ${id} is flagged but already has ${existing} mutation row(s); refusing to rebuild`,
      );
    }
    await rebuildSessionTreeLog(db.sessions, db.sessionMutations, row);
    await db.sessions.update(id, { treeMigrationFailed: undefined });
  });
}

/**
 * v1→v2 数据迁移：把每行的线性 `messages[]` 转成 `sessionMutations` 表里的
 * mutation 日志（转换规则见 lib/persistence/migrate-messages.ts）。
 *
 * - versionchange 事务整体原子：中途失败（含 SW 被杀）自动回滚回 v1，下次打开重跑；
 *   事务内只 await Dexie/IDB 操作（转换是纯同步函数），否则会 PrematureCommit。
 * - 按主键分页游标逐批处理，不把全部会话一次性载入内存。
 * - 单行损坏不炸全库：打 `treeMigrationFailed` 标记、保留 `messages` 走遗留读路径。
 * - `messages` 字段本身原样保留（影子副本），作为迁移失败懒重试与人工恢复的
 *   数据源，待树化路径稳定后的后续版本再清理。
 * - `updatedAt` 不动（会话列表排序与备份 LWW 依赖它）；`messageCount` 重算为
 *   message entry 数（不再包含 compactionSummary / permissionRequest 等自定义消息）。
 *
 * 导出仅供单元测试以相同 schema 复现 upgrade 路径。
 */
export async function migrateSessionsToTree(tx: Transaction): Promise<void> {
  const sessions = tx.table<SessionRecord, string>('sessions');
  const mutationsTable = tx.table<SessionMutationRow, [string, number]>('sessionMutations');
  let cursor = '';
  for (;;) {
    const rows: SessionRecord[] =
      cursor === ''
        ? await sessions.orderBy(':id').limit(TREE_MIGRATION_BATCH).toArray()
        : await sessions.where(':id').above(cursor).limit(TREE_MIGRATION_BATCH).toArray();
    if (rows.length === 0) break;
    for (const row of rows) {
      try {
        await rebuildSessionTreeLog(sessions, mutationsTable, row);
      } catch (error) {
        console.warn(`[db] v1→v2 tree migration failed for session ${row.id}, keeping legacy row`, error);
        // bulkAdd 是逐条尝试语义（部分成功），必须清掉本行已写入的半截日志——
        // 否则带 seq 空洞的孤儿日志会在 load 时被静默截尾使用
        await mutationsTable.where('sessionId').equals(row.id).delete();
        await sessions.update(row.id, { treeMigrationFailed: true as const });
      }
    }
    cursor = rows[rows.length - 1].id;
  }
}

db.version(2)
  .stores({
    sessionMutations: SESSION_MUTATIONS_SCHEMA,
  })
  .upgrade(migrateSessionsToTree);

/** 同一 Dexie 实例的树后端类型视图，供 DexieSessionRepo 使用。SessionRecord 的
 *  字段是 SessionTreeMeta 的超集（多出 v1 遗留的 `messages` 影子字段），运行时
 *  行结构兼容，仅类型层收窄断言。 */
export const sessionTreeDb = db as unknown as SessionTreeDb;

// ─── Session CRUD ───

export async function getSession(id: string): Promise<SessionRecord | undefined> {
  return db.sessions.get(id);
}

/** 按 seq 序读取一个会话的完整 mutation 日志（复合主键序即 seq 序，无需内存排序）。
 *  备份采集在页面侧直读用（读路径不受「background 唯一写者」约束）。 */
export async function getSessionMutations(id: string): Promise<SessionMutationRow[]> {
  return db.sessionMutations
    .where('[sessionId+seq]')
    .between([id, Dexie.minKey], [id, Dexie.maxKey])
    .toArray();
}

export async function listSessions(): Promise<SessionRecord[]> {
  return db.sessions.orderBy('updatedAt').reverse().toArray();
}

/** {@link getSessionLabels} 返回的轻量投影：只含把工作区 UUID 翻译成人类标签所需的
 *  字段（标题 + 时间），不带 messages，调用方拿去渲染目录列表 / 头部信息条即可。 */
export interface SessionLabelRow {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 按 id 批量取会话的标签字段（标题 + 时间）。供 VFS 浏览器把 `/workspaces/<uuid>/`
 * 目录翻译成「会话标题 · 日期」用——一次查询解析一屏 UUID，避免逐目录查库。
 *
 * 注意：Dexie 会先把命中的整行（含 messages）载入内存再投影，这是一次性的 browse
 * 动作、非热路径，故可接受。查不到的 id 不出现在结果里，由调用方回落为「未知会话」。
 */
export async function getSessionLabels(ids: string[]): Promise<SessionLabelRow[]> {
  if (ids.length === 0) return [];
  const rows = await db.sessions.where('id').anyOf(ids).toArray();
  return rows.map((s) => ({
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }));
}

/**
 * 更新会话的模型 / 思考档。这是「每个对话各记一个模型」的落库点——用户在某会话切换
 * 模型并发送时，后台据此把选择写进该会话行（运行时再从会话行回读，不再读全局）。
 * 只补传入的字段，未传字段保持原值；全空 patch 不动 updatedAt（避免无谓把会话顶到
 * 历史列表前面，它按 updatedAt 排序）。`provider` 是 provider key（含 custom: 前缀），
 * `model` 是 modelId，与建行时的快照字段同形。
 */
export async function updateSessionSettings(
  id: string,
  settings: { provider?: string; model?: string; thinkingLevel?: string },
): Promise<void> {
  const patch: Partial<SessionRecord> = {};
  if (settings.provider !== undefined) patch.provider = settings.provider;
  if (settings.model !== undefined) patch.model = settings.model;
  if (settings.thinkingLevel !== undefined) patch.thinkingLevel = settings.thinkingLevel;
  if (Object.keys(patch).length === 0) return;
  patch.updatedAt = Date.now();
  await db.sessions.update(id, patch);
}

// ─── Backup restore (transactional) ───

/**
 * 在单个 Dexie rw 事务内完成「读 existing → 决策 → (可选清空) → 批量写入 → 重建
 * mutation 日志」，保证恢复要么整体生效、要么整体回滚——避免「清空后写入失败」
 * 导致本地会话丢失，也让读写在 IndexedDB 层原子隔离，杜绝中途被其它写事务穿插。
 *
 * 树化后恢复必须双写：会话行的真相在 `sessionMutations` 日志里，只写 `sessions`
 * 行会让恢复的消息在树读路径上不可见。每行的日志来源二选一：
 * - 记录带合法的 `mutations`（新备份，严格 replay 校验通过）→ 直接写入，分支保留；
 * - 否则（v1 备份 / 日志损坏）→ 以 `messages` 重建线性日志（丢分支保主干）。
 * `mutations` 字段只在线格式存在，写 `sessions` 行前剥离；replace 模式先清空两表。
 *
 * 决策逻辑由调用方以纯函数 `decide` 注入（见 lib/backup/sources/sessions.ts），db 层
 * 只负责存储，不引入备份业务知识（保持分层）。
 */
export async function applySessionsTransactional(
  decide: (existing: SessionRecord[]) => { clearAll: boolean; toPut: SessionBackupRecord[] },
): Promise<void> {
  await db.transaction('rw', db.sessions, db.sessionMutations, async () => {
    const existing = await db.sessions.toArray();
    const { clearAll, toPut } = decide(existing);
    if (clearAll) {
      await db.sessions.clear();
      await db.sessionMutations.clear();
    }
    if (toPut.length > 0) {
      const rows = toPut.map(({ mutations: _log, ...record }) => record);
      await db.sessions.bulkPut(rows);
      for (const incoming of toPut) {
        const { mutations: log, ...record } = incoming;
        if (log !== undefined && validateMutationLog(log)) {
          // 覆盖式写入完整日志（merge 模式下被替换的会话可能残留旧日志，先删后建）。
          // 写前整形消息体（issue #43：坏数据冻进 append-only 日志即永久化）
          const clean = sanitizeMutationLog(log);
          await db.sessionMutations.where('sessionId').equals(record.id).delete();
          await db.sessionMutations.bulkAdd(
            clean.map((mutation) => ({ sessionId: record.id, seq: mutationSeq(mutation), mutation })),
          );
          await db.sessions.update(record.id, { messageCount: countMessageEntries(clean) });
        } else {
          if (log !== undefined) {
            console.warn(
              `[db] backup mutation log for session ${record.id} failed validation, rebuilding from messages`,
            );
          }
          await rebuildSessionTreeLog(db.sessions, db.sessionMutations, record);
        }
      }
    }
  });
}

import Dexie, { type EntityTable } from 'dexie';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { asString, isValidSessionId } from './utils';

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
}

/**
 * 把通过关键字段校验的不可信输入规整成完整 `SessionRecord`。与 `SessionRecord` 同源
 * 维护——加字段时在此逐字段补默认。描述性字段（title / model / provider /
 * userInstructions / thinkingLevel）缺失或类型不对时补安全默认，而非拒绝整条记录。
 * `messageCount` 不信输入、直接重算 `= messages.length`（它本是 messages 的派生缓存，
 * 见 `updateSessionMessages`）。`messages` 原样透传，不碰其内部结构（第三方
 * `AgentMessage`，形态会随库演进）。
 */
export function toSessionRecord(input: SessionRecordLike): SessionRecord {
  const s = input as unknown as Record<string, unknown>;
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
};

db.version(1).stores({
  sessions: 'id, updatedAt',
});

// ─── Session CRUD ───

export async function createSession(session: SessionRecord): Promise<void> {
  await db.sessions.add(session);
}

export async function getSession(id: string): Promise<SessionRecord | undefined> {
  return db.sessions.get(id);
}

export async function listSessions(): Promise<SessionRecord[]> {
  return db.sessions.orderBy('updatedAt').reverse().toArray();
}

export async function updateSessionMessages(
  id: string,
  messages: AgentMessage[],
): Promise<void> {
  // Token / cost totals are derived on-demand from each AssistantMessage.usage
  // in the UI; we deliberately do not persist aggregates to keep a single
  // source of truth (see entrypoints/sidepanel/pages/chat/index.tsx).
  await db.sessions.update(id, {
    messages,
    messageCount: messages.length,
    updatedAt: Date.now(),
  });
}

export async function updateSessionTitle(id: string, title: string): Promise<void> {
  await db.sessions.update(id, { title, updatedAt: Date.now() });
}

export async function deleteSession(id: string): Promise<void> {
  await db.sessions.delete(id);
}

// ─── Backup restore (transactional) ───

/**
 * 在单个 Dexie rw 事务内完成「读 existing → 决策 → (可选清空) → 批量写入」，保证
 * 恢复要么整体生效、要么整体回滚——避免「清空后写入失败」导致本地会话丢失，也让
 * 读取与写入在 IndexedDB 层原子隔离，杜绝中途被其它写事务穿插。
 *
 * 决策逻辑由调用方以纯函数 `decide` 注入（见 lib/backup/sources/sessions.ts），db 层
 * 只负责存储，不引入备份业务知识（保持分层）。
 */
export async function applySessionsTransactional(
  decide: (existing: SessionRecord[]) => { clearAll: boolean; toPut: SessionRecord[] },
): Promise<void> {
  await db.transaction('rw', db.sessions, async () => {
    const existing = await db.sessions.toArray();
    const { clearAll, toPut } = decide(existing);
    if (clearAll) await db.sessions.clear();
    if (toPut.length > 0) await db.sessions.bulkPut(toPut);
  });
}

// ─── Throttled writer ───

export class ThrottledSessionWriter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { id: string; messages: AgentMessage[] } | null = null;

  constructor(private delayMs = 3000) {}

  schedule(id: string, messages: AgentMessage[]): void {
    this.pending = { id, messages: [...messages] };
    if (this.timer) return; // Already scheduled
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending) {
      const { id, messages } = this.pending;
      this.pending = null;
      await updateSessionMessages(id, messages);
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }
}

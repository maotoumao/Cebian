// Background-only session store（树化门面）。
// background 是 `sessions` / `sessionMutations` 两表的唯一写者——消除多 sidepanel 写冲突。
// transcript 的真相在 mutation 日志（会话树）里；`sessions` 行只承载列表元数据
// （v1 遗留的 `messages` 影子字段仅作迁移保险，不再更新）。

import { uuidv7, type AgentMessage, type Session } from '@earendil-works/pi-agent-core';
import {
  applySessionsTransactional,
  getSession,
  listSessions,
  retryTreeMigration,
  sessionTreeDb,
  updateSessionSettings,
  type SessionBackupRecord,
  type SessionRecord,
} from '@/lib/persistence/db';
import { DexieSessionRepo, type SessionTreeMeta } from '@/lib/persistence/session-tree';
import {
  buildBranchInfo,
  messageToEntryBody,
  projectEntries,
  type BranchEntryInfo,
} from '@/lib/agent/session-projection';
import { sanitizeAgentMessages } from '@/lib/agent/message-helpers';
import { planSessionWrites } from '@/lib/backup/sources/sessions';
import type { RestoreStrategy } from '@/lib/backup/types';
import type { ApplySessionsResult } from '@/lib/backup/sources/sessions';

/** `open()` 的结果：IPC 兼容的 record 视图 + 树句柄 + 投影对齐的 entryId 表。 */
interface LoadedSession {
  /** meta 行 + 当前 main 分支投影出的 `messages`（`session_loaded` 兼容形状）。 */
  record: SessionRecord;
  /** pi 会话树句柄，后续追加 / moveLane 都经它。 */
  tree: Session<SessionTreeMeta>;
  /** 与 `record.messages` 逐位对齐的来源 entryId（见 session-projection）。 */
  entryIds: string[];
  /** 当前分支上各分支点的兄弟信息（稀疏，仅兄弟数 ≥2）。 */
  branchInfo: Record<string, BranchEntryInfo>;
}

/** 新会话行的应用元数据（id 由调用方生成；messageCount 恒从 0 起）。 */
interface CreateSessionFields {
  id: string;
  title: string;
  model: string;
  provider: string;
  userInstructions: string;
  thinkingLevel: string;
}

/**
 * 树 append 入口：一条消息按共享映射（`messageToEntryBody`）落成 entry。写入前过
 * 一道 sanitize——append-only 日志一旦冻结坏数据即永久化（issue #43 防线）。
 * 返回新 entry 的 id（供编排层维护投影对齐表）。
 */
async function appendSessionMessage(
  tree: Session<SessionTreeMeta>,
  message: AgentMessage,
): Promise<string> {
  const [clean] = sanitizeAgentMessages([message]);
  const entry = await tree.appendEntry({ ...messageToEntryBody(clean), id: uuidv7() }, 'main');
  return entry.id;
}

class SessionStore {
  private readonly repo = new DexieSessionRepo(sessionTreeDb);

  /** 打开会话：meta 行 + 树句柄 + 当前 main 分支投影。行不存在返回 undefined。 */
  async open(id: string): Promise<LoadedSession | undefined> {
    let row = await getSession(id);
    if (!row) return undefined;
    if (row.treeMigrationFailed) {
      // v1→v2 迁移失败行的懒重试：原始数据仍在 messages 影子字段。重试失败则
      // **拒绝打开**（抛给调用方 → UI 报错）而不是以空树降级——空树可写会让
      // 后续成功的重建删掉期间写入的新消息（静默丢失）。成功后逐出 repo 缓存
      //（防早前缓存的空树句柄与重建后的日志撞 seq），并重读行——重建清掉了
      // 标记、重算了 messageCount，返回的 record 不能再带旧值。
      await retryTreeMigration(id);
      this.repo.evict(id);
      row = (await getSession(id)) ?? row;
    }
    const tree = await this.repo.open({ id } as SessionTreeMeta);
    const entries = await tree.findEntriesOnBranch({ order: 'oldestFirst' });
    const { messages, entryIds } = projectEntries(entries);
    const branchInfo = buildBranchInfo(await tree.findEntries({ order: 'oldestFirst' }), entryIds);
    // 投影后再兜一道 sanitize（防御历史日志中的脏数据），copy-on-write 常态零分配
    return { record: { ...row, messages: sanitizeAgentMessages(messages) }, tree, entryIds, branchInfo };
  }

  /** 兼容视图：只要 record（IPC `session_loaded` / 标题读取用）。 */
  async load(id: string): Promise<SessionRecord | undefined> {
    return (await this.open(id))?.record;
  }

  /** 新会话建行（空树）。id 已存在时抛 pi 的 SessionError('already_exists')。 */
  async create(fields: CreateSessionFields): Promise<void> {
    await this.repo.create(fields);
  }

  /** 建行并写入初始消息（划词动作「在侧边栏继续」的固化路径）。 */
  async createWithMessages(fields: CreateSessionFields, messages: AgentMessage[]): Promise<void> {
    const tree = await this.repo.create(fields);
    for (const message of messages) {
      await appendSessionMessage(tree, message);
    }
  }

  async list(): Promise<Omit<SessionRecord, 'messages'>[]> {
    const all = await listSessions();
    return all.map(({ messages: _messages, ...rest }) => rest);
  }

  /** 删除会话：repo 负责 meta 行 + mutation 日志 + 在途写清扫（drain + tombstone）。 */
  async delete(id: string): Promise<void> {
    await this.repo.delete({ id } as SessionTreeMeta);
  }

  /** 把会话的模型 / 思考档落库（background 是唯一写者，故经由此处）。 */
  async updateSettings(
    id: string,
    settings: { provider?: string; model?: string; thinkingLevel?: string },
  ): Promise<void> {
    await updateSessionSettings(id, settings);
  }

  /**
   * 备份：按恢复策略把会话写回。纯决策（写哪些 / 跳过哪些 / 是否清空）在
   * `planSessionWrites`；执行在 `applySessionsTransactional` 的单个 rw 事务里
   * （含 mutation 日志重建——树化后恢复必须双写，见 db.ts）。
   *
   * 已知限制（沿袭）：不强制运行中的 agent 暂停。恢复是用户主动发起的破坏性
   * 操作，由 UI 层提示恢复期间不要同时对话；恢复后活 agent 若再写入，其旧树句柄
   * 的写要么撞 seq 主键显式失败，要么落成超出重建日志的孤儿行（下次 open 时被
   * 坏尾截断清理）——两种结局都不会静默覆盖恢复结果。
   */
  async applyAll(
    records: SessionBackupRecord[],
    strategy: RestoreStrategy,
  ): Promise<ApplySessionsResult> {
    let result: ApplySessionsResult = { written: 0, skipped: 0, cleared: false };
    await applySessionsTransactional((existing) => {
      const plan = planSessionWrites(existing, records, strategy);
      result = {
        written: plan.toPut.length,
        skipped: plan.skipped.length,
        cleared: plan.clearAll,
      };
      return { clearAll: plan.clearAll, toPut: plan.toPut };
    });
    // 盘上日志已被事务重写：清空 repo 缓存，下次 open 重放新日志
    this.repo.evictAll();
    return result;
  }
}

// ─── Public API ───

export const sessionStore = new SessionStore();
export { appendSessionMessage };
export type { LoadedSession };

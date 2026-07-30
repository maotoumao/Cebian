// Background-only session store.
// Sole writer to Dexie DB — eliminates write conflicts from multiple sidepanels.

import {
  createSession,
  getSession,
  listSessions,
  deleteSession,
  updateSessionSettings,
  applySessionsTransactional,
  ThrottledSessionWriter,
  type SessionRecord,
} from '@/lib/persistence/db';
import { planSessionWrites } from '@/lib/backup/sources/sessions';
import type { RestoreStrategy } from '@/lib/backup/types';
import type { ApplySessionsResult } from '@/lib/backup/sources/sessions';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { sanitizeAgentMessages } from '@/lib/agent/message-helpers';

class SessionStore {
  private writers = new Map<string, ThrottledSessionWriter>();

  async create(session: SessionRecord): Promise<void> {
    await createSession(session);
  }

  async load(id: string): Promise<SessionRecord | undefined> {
    const record = await getSession(id);
    if (!record) return record;
    // 唯一的加载边界：把历史整形回类型契约（null text/thinking/name → ''），一处同时
    // 覆盖 agent 水合、UI 冷加载广播与其它 load 消费者，避免 pi 的 token 估算器取 .length
    // 整轮崩（issue #43），并让渲染层拿到干净数据。copy-on-write：干净时零分配
    const messages = sanitizeAgentMessages(record.messages);
    if (messages === record.messages) return record;
    // 坏消息的产生源尚未定位（issue #43）：命中即打一条带 id + 条数的日志，便于回查现物
    const healed = messages.reduce((n, m, i) => n + (m !== record.messages[i] ? 1 : 0), 0);
    console.warn(
      `[session-store] session ${id}: healed ${healed} malformed message(s) on load — invalid null/undefined field(s) in history (issue #43)`,
    );
    return { ...record, messages };
  }

  async list(): Promise<Omit<SessionRecord, 'messages'>[]> {
    const all = await listSessions();
    return all.map(({ messages, ...rest }) => rest);
  }

  async delete(id: string): Promise<void> {
    await deleteSession(id);
    this.disposeWriter(id);
  }

  /** 把会话的模型 / 思考档落库（background 是 Dexie 唯一写者，故经由此处）。 */
  async updateSettings(
    id: string,
    settings: { provider?: string; model?: string; thinkingLevel?: string },
  ): Promise<void> {
    await updateSessionSettings(id, settings);
  }

  scheduleWrite(id: string, messages: AgentMessage[]): void {
    let writer = this.writers.get(id);
    if (!writer) {
      writer = new ThrottledSessionWriter();
      this.writers.set(id, writer);
    }
    writer.schedule(id, messages);
  }

  async flush(id: string): Promise<void> {
    const writer = this.writers.get(id);
    if (writer) await writer.flush();
  }

  /** 把全部待写的节流写立即落库。采集备份前由 flush 信号触发，确保页面随后直读 Dexie
   *  时能读到仍躺在 throttle 计时器里的在途消息。 */
  async flushAll(): Promise<void> {
    await Promise.all([...this.writers.values()].map((w) => w.flush()));
  }

  /**
   * 备份：按恢复策略把会话写回。background 是 Dexie 唯一写者，故 merge/replace
   * 决策必须在此执行。
   *
   * 纯决策（写哪些 / 跳过哪些 / 是否清空）在 `planSessionWrites`；本方法是执行该
   * 计划的存储胶水。读 existing → 决策 → 写入整体放进同一个 Dexie rw 事务
   * （`applySessionsTransactional`），既保证替换模式「清空后写入」原子（写入失败
   * 不会丢数据），又让读写在 IndexedDB 层隔离，杜绝中途被其它写事务穿插导致旧
   * 备份覆盖更新的本地会话。
   *
   * 已知限制：本方法不强制运行中的 agent 暂停。恢复是用户在设置里主动发起的破坏
   * 性操作，由 UI 层负责提示恢复期间不要同时进行对话；恢复后 agent 若立刻又写入
   * 新数据，属于正常的 last-write-wins。
   */
  async applyAll(
    records: SessionRecord[],
    strategy: RestoreStrategy,
  ): Promise<ApplySessionsResult> {
    await this.flushAll();
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
    // replace 模式清空了会话表：恢复前建的 writer 已无对应会话行，销毁掉——既回收内存，
    // 也丢弃还卡在 timer / pending 里的旧写
    //
    // 恢复不强制暂停运行中的 agent（见上方已知限制），事务期间可能又有 scheduleWrite
    // 落进来。丢弃而不是 flush 它是有意的：备份通常会重新插入同一批 sessionId，把旧内容
    // 写回去就盖掉了刚恢复的消息。已经进入 `updateSessionMessages` 的那一笔取消不了，
    // 仍受既有的 last-write-wins 限制
    if (result.cleared) this.disposeAllWriters();
    return result;
  }

  private disposeWriter(id: string): void {
    const writer = this.writers.get(id);
    if (writer) {
      writer.dispose();
      this.writers.delete(id);
    }
  }

  private disposeAllWriters(): void {
    for (const writer of this.writers.values()) writer.dispose();
    this.writers.clear();
  }
}

export const sessionStore = new SessionStore();

// Background-only session store.
// Sole writer to Dexie DB — eliminates write conflicts from multiple sidepanels.

import {
  createSession,
  getSession,
  listSessions,
  deleteSession,
  applySessionsTransactional,
  ThrottledSessionWriter,
  type SessionRecord,
} from '@/lib/persistence/db';
import { planSessionWrites } from '@/lib/backup/sources/sessions';
import type { RestoreStrategy } from '@/lib/backup/types';
import type { ApplySessionsResult } from '@/lib/backup/sources/sessions';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

class SessionStore {
  private writers = new Map<string, ThrottledSessionWriter>();

  async create(session: SessionRecord): Promise<void> {
    await createSession(session);
  }

  async load(id: string): Promise<SessionRecord | undefined> {
    return getSession(id);
  }

  async list(): Promise<Omit<SessionRecord, 'messages'>[]> {
    const all = await listSessions();
    return all.map(({ messages, ...rest }) => rest);
  }

  async delete(id: string): Promise<void> {
    await deleteSession(id);
    this.disposeWriter(id);
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
    return result;
  }

  private disposeWriter(id: string): void {
    const writer = this.writers.get(id);
    if (writer) {
      writer.dispose();
      this.writers.delete(id);
    }
  }
}

export const sessionStore = new SessionStore();

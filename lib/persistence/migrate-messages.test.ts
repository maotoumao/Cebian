// fake-indexeddb 必须先于任何 Dexie 使用注入全局 indexedDB
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { SessionState, type SessionMutation } from '@/lib/shims/pi-session-state';
import { entriesToMessages } from '@/lib/agent/session-projection';
import { sanitizeAgentMessages } from '@/lib/agent/message-helpers';
import { messagesToMutations } from '@/lib/persistence/migrate-messages';
import { migrateSessionsToTree, type SessionRecord } from '@/lib/persistence/db';
import {
  countMessageEntries,
  SESSION_MUTATIONS_SCHEMA,
  type SessionMutationRow,
} from '@/lib/persistence/session-tree';

// spy 模式：保留真实实现，仅供失败路径测试注入一次 throw
vi.mock('@/lib/persistence/migrate-messages', { spy: true });

// ─── fixtures ───

const T = 1_700_000_000_000;

/** 一段覆盖全部消息形态的历史：普通三角色、压缩摘要、已决策/悬置的权限卡、
 *  脏数据（null text，issue #43）。 */
function richHistory(): AgentMessage[] {
  return [
    { role: 'user', content: '<user-request>你好</user-request>', timestamp: T },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '想一想' },
        { type: 'toolCall', id: 'tc-1', name: 'read_page', arguments: {} },
      ],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-x',
      usage: {} as never,
      stopReason: 'toolUse',
      timestamp: T + 1,
    },
    {
      role: 'permissionRequest',
      toolCallId: 'tc-1',
      toolName: 'read_page',
      title: '想要读取页面',
      permissions: ['pageExecuteJs'],
      decision: 'always',
      timestamp: T + 2,
    },
    { role: 'toolResult', toolCallId: 'tc-1', toolName: 'read_page', content: [], details: {}, timestamp: T + 3 },
    { role: 'compactionSummary', summary: '早期对话的摘要', tokensBefore: 1234, timestamp: T + 4 },
    { role: 'user', content: '<user-request>继续</user-request>', timestamp: T + 5 },
    {
      // 脏数据：text 为 null（issue #43），迁移入口应先 sanitize 再冻结
      role: 'assistant',
      content: [{ type: 'text', text: null }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-x',
      usage: {} as never,
      stopReason: 'stop',
      timestamp: T + 6,
    },
  ] as unknown as AgentMessage[];
}

/** 把 mutation 日志重放进 SessionState 并取出 main 分支（oldestFirst）。 */
function replayMainBranch(mutations: SessionMutation[]) {
  const state = new SessionState();
  for (const m of mutations) state.applyMutation(m);
  const leafId = state.requireLane('main');
  return leafId === null ? [] : state.findEntriesOnBranch({ start: leafId, order: 'oldestFirst' });
}

// ─── messagesToMutations ───

describe('messagesToMutations', () => {
  it('round-trip 无损：迁移出的树投影回来与 sanitize 后的原数组完全相等', () => {
    const messages = richHistory();
    const mutations = messagesToMutations(messages, T + 100);
    const entries = replayMainBranch(mutations);
    expect(entriesToMessages(entries)).toEqual(sanitizeAgentMessages(messages));
  });

  it('结构正确：单链 parentId、连续 seq、末尾 lane 指针、entry 类型映射', () => {
    const mutations = messagesToMutations(richHistory(), T);
    // 7 条消息 → 7 个 entry + 1 条 lane
    expect(mutations).toHaveLength(8);
    const entries = mutations.flatMap((m) => (m.kind === 'entry' ? [m.entry] : []));
    expect(entries.map((e) => e.type)).toEqual([
      'message',
      'message',
      'custom',
      'message',
      'compaction',
      'message',
      'message',
    ]);
    // 单链：每个 entry 的 parentId 指向前一个；首个为 null
    expect(entries[0].parentId).toBeNull();
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].parentId).toBe(entries[i - 1].id);
    }
    // seq 连续从 1 开始；id 唯一
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    // 消息自身的 timestamp 保留
    expect(entries[0].timestamp).toBe(T);
    // lane mutation 指向最后一个 entry
    const lane = mutations[mutations.length - 1];
    expect(lane).toEqual({ kind: 'lane', seq: 8, lane: 'main', leafId: entries[6].id });
  });

  it('compactionSummary → CompactionEntry：retainedTail 置空、tokensBefore 保留', () => {
    const mutations = messagesToMutations(richHistory(), T);
    const compaction = mutations.flatMap((m) =>
      m.kind === 'entry' && m.entry.type === 'compaction' ? [m.entry] : [],
    )[0];
    expect(compaction).toMatchObject({
      summary: '早期对话的摘要',
      retainedTail: [],
      tokensBefore: 1234,
      timestamp: T + 4,
    });
  });

  it('permissionRequest → CustomEntry：data 保留全部字段（含定格的 decision），role 剥离', () => {
    const mutations = messagesToMutations(richHistory(), T);
    const custom = mutations.flatMap((m) =>
      m.kind === 'entry' && m.entry.type === 'custom' ? [m.entry] : [],
    )[0];
    expect(custom.customType).toBe('permissionRequest');
    expect(custom.data).toEqual({
      toolCallId: 'tc-1',
      toolName: 'read_page',
      title: '想要读取页面',
      permissions: ['pageExecuteJs'],
      decision: 'always',
      timestamp: T + 2,
    });
  });

  it('LLM 视图等价：树的压缩折叠（最后一条 compaction 起）与旧 transformContext 切片一致', () => {
    const messages = richHistory();
    const mutations = messagesToMutations(messages, T);
    const entries = replayMainBranch(mutations);
    // 旧管线：从最后一条 compactionSummary 起切片（factory.ts 的 transformContext 语义）
    const sanitized = sanitizeAgentMessages(messages);
    const lastSummaryIdx = sanitized.findLastIndex((m) => m.role === 'compactionSummary');
    const legacyView = sanitized.slice(lastSummaryIdx);
    // 新管线：defaultContextEntryTransform 语义 = [最后一条 compaction entry, ...其后]
    const compactionIdx = entries.findLastIndex((e) => e.type === 'compaction');
    const treeView = entriesToMessages([entries[compactionIdx], ...entries.slice(compactionIdx + 1)]);
    expect(treeView).toEqual(legacyView);
  });

  it('retainedTail round-trip：新压缩形态（尾部追加 + 保留区副本）经树往返无损', () => {
    const retained = [
      { role: 'user', content: '<user-request>保留的问题</user-request>', timestamp: T + 10 },
    ] as unknown as AgentMessage[];
    const summaryMsg = {
      role: 'compactionSummary',
      summary: '新式摘要',
      tokensBefore: 999,
      timestamp: T + 11,
      retainedTail: retained,
    } as unknown as AgentMessage;
    const messages = [...retained, summaryMsg];
    const mutations = messagesToMutations(messages, T);
    const entries = replayMainBranch(mutations);
    const compaction = entries.find((e) => e.type === 'compaction');
    expect(compaction && compaction.type === 'compaction' ? compaction.retainedTail : null).toEqual(
      retained,
    );
    // 投影回来 retainedTail 重新挂上（transformContext 依赖它重建 LLM 视图）
    expect(entriesToMessages(entries)).toEqual(messages);
  });

  it('timestamp 缺失时回退兜底值；空历史返回空日志（无 lane mutation）', () => {
    const noTs = [{ role: 'user', content: 'hi' }] as unknown as AgentMessage[];
    const mutations = messagesToMutations(noTs, T + 42);
    const entry = mutations[0];
    if (entry.kind !== 'entry') throw new Error('expected entry');
    expect(entry.entry.timestamp).toBe(T + 42);
    expect(messagesToMutations([], T)).toEqual([]);
  });

  it('countMessageEntries 只数 message entry', () => {
    const mutations = messagesToMutations(richHistory(), T);
    // 7 条消息里 compactionSummary 与 permissionRequest 不算
    expect(countMessageEntries(mutations)).toBe(5);
  });
});

// ─── Dexie v1→v2 upgrade（真实 upgrade 函数，隔离库复现 schema）───

describe('migrateSessionsToTree (Dexie upgrade)', () => {
  function v1Record(id: string, messages: unknown[], overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      id,
      createdAt: T,
      updatedAt: T + 1,
      title: '会话',
      model: 'm',
      provider: 'p',
      userInstructions: '',
      thinkingLevel: 'medium',
      messageCount: messages.length,
      messages: messages as SessionRecord['messages'],
      ...overrides,
    };
  }

  async function seedV1(name: string, records: SessionRecord[]): Promise<void> {
    const v1 = new Dexie(name);
    v1.version(1).stores({ sessions: 'id, updatedAt' });
    await v1.table('sessions').bulkAdd(records);
    v1.close();
  }

  function openV2(name: string) {
    const v2 = new Dexie(name) as Dexie & {
      sessions: Dexie.Table<SessionRecord, string>;
      sessionMutations: Dexie.Table<SessionMutationRow, [string, number]>;
    };
    v2.version(1).stores({ sessions: 'id, updatedAt' });
    v2.version(2).stores({ sessionMutations: SESSION_MUTATIONS_SCHEMA }).upgrade(migrateSessionsToTree);
    return v2;
  }

  it('存量行迁出 mutation 日志：messages 影子保留、updatedAt 不动、messageCount 重算', async () => {
    const name = `cebian-migrate-${crypto.randomUUID()}`;
    await seedV1(name, [v1Record('s1', richHistory())]);

    const v2 = openV2(name);
    const rows = await v2.sessionMutations.where('sessionId').equals('s1').toArray();
    expect(rows).toHaveLength(8); // 7 entry + 1 lane
    const row = (await v2.sessions.get('s1'))!;
    expect(row.messages).toHaveLength(7); // 影子副本原样保留
    expect(row.updatedAt).toBe(T + 1);
    expect(row.messageCount).toBe(5); // 只数 message entry
    expect(row.treeMigrationFailed).toBeUndefined();
    // 迁出的日志可被 SessionState 重放且投影一致
    const entries = replayMainBranch(rows.map((r) => r.mutation));
    expect(entriesToMessages(entries)).toEqual(sanitizeAgentMessages(richHistory()));
    v2.close();
    await v2.delete();
  });

  it('messages 缺失的行走空日志而非异常', async () => {
    const name = `cebian-migrate-${crypto.randomUUID()}`;
    await seedV1(name, [
      v1Record('good', [{ role: 'user', content: 'hi', timestamp: T }]),
      { ...v1Record('no-messages', []), messages: undefined as unknown as SessionRecord['messages'] },
    ]);

    const v2 = openV2(name);
    expect(await v2.sessionMutations.where('sessionId').equals('good').count()).toBe(2);
    expect(await v2.sessionMutations.where('sessionId').equals('no-messages').count()).toBe(0);
    const bad = (await v2.sessions.get('no-messages'))!;
    expect(bad.treeMigrationFailed).toBeUndefined(); // 缺 messages 不算失败，只是空日志
    expect(bad.messageCount).toBe(0);
    v2.close();
    await v2.delete();
  });

  it('单行损坏不炸全库：坏行打 treeMigrationFailed 标记且无半截日志残留，好行正常迁移', async () => {
    const name = `cebian-migrate-${crypto.randomUUID()}`;
    // 'a-bad' 按主键序先被处理；对它注入一次转换异常，压 catch 分支
    await seedV1(name, [
      v1Record('a-bad', [{ role: 'user', content: '坏', timestamp: T }]),
      v1Record('b-good', [{ role: 'user', content: '好', timestamp: T }]),
    ]);
    vi.mocked(messagesToMutations).mockImplementationOnce(() => {
      throw new Error('injected conversion failure');
    });

    const v2 = openV2(name);
    const bad = (await v2.sessions.get('a-bad'))!;
    expect(bad.treeMigrationFailed).toBe(true);
    expect(bad.messages).toHaveLength(1); // 遗留字段保留，可走 legacy 读路径
    expect(await v2.sessionMutations.where('sessionId').equals('a-bad').count()).toBe(0);
    // 好行不受影响
    const good = (await v2.sessions.get('b-good'))!;
    expect(good.treeMigrationFailed).toBeUndefined();
    expect(await v2.sessionMutations.where('sessionId').equals('b-good').count()).toBe(2);
    v2.close();
    await v2.delete();
  });

  it('分页游标覆盖多批：行数超过单批上限时全部迁移', async () => {
    const name = `cebian-migrate-${crypto.randomUUID()}`;
    const records = Array.from({ length: 120 }, (_, i) =>
      v1Record(`s-${String(i).padStart(3, '0')}`, [{ role: 'user', content: `m${i}`, timestamp: T + i }]),
    );
    await seedV1(name, records);

    const v2 = openV2(name);
    expect(await v2.sessionMutations.count()).toBe(120 * 2); // 每会话 1 entry + 1 lane
    v2.close();
    await v2.delete();
  });
});

// fake-indexeddb 必须先于任何 Dexie 使用注入全局 indexedDB（本文件的事务测试直连
// db.ts 的 cebian 库；vitest 每个测试文件独立 worker，全局互不串扰）
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentMessage, Entry } from '@earendil-works/pi-agent-core';
import {
  applySessionsTransactional,
  getSessionMutations,
  toSessionRecord,
  isValidSessionLike,
  type SessionBackupRecord,
  type SessionRecord,
  type SessionRecordLike,
} from '@/lib/persistence/db';
import {
  mutationsToMessages,
  projectMutationLog,
  sanitizeMutationLog,
  validateMutationLog,
} from '@/lib/persistence/migrate-messages';
import { sessionTreeDb } from '@/lib/persistence/db';
import type { SessionMutation } from '@/lib/shims/pi-session-state';

const base: SessionRecordLike = {
  id: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
  createdAt: 1000,
  updatedAt: 2000,
  messages: [{ role: 'user' }, { role: 'assistant' }] as unknown[],
};

describe('isValidSessionLike', () => {
  it('关键字段齐全 + messages 元素是对象 → 通过', () => {
    expect(isValidSessionLike(base)).toBe(true);
    expect(isValidSessionLike({ ...base, messages: [] })).toBe(true);
  });

  it('id 非 UUID / 时间非有限数 → 拒绝', () => {
    expect(isValidSessionLike({ ...base, id: 'not-a-uuid' })).toBe(false);
    expect(isValidSessionLike({ ...base, createdAt: NaN })).toBe(false);
    expect(isValidSessionLike({ ...base, updatedAt: 'x' })).toBe(false);
  });

  it('messages 非数组 → 拒绝', () => {
    expect(isValidSessionLike({ ...base, messages: 'nope' })).toBe(false);
  });

  it('messages 含 null / 原始值元素 → 拒绝（防渲染器解引用 msg.role 崩溃）', () => {
    expect(isValidSessionLike({ ...base, messages: [null] })).toBe(false);
    expect(isValidSessionLike({ ...base, messages: [{ role: 'user' }, 'oops'] })).toBe(false);
    expect(isValidSessionLike({ ...base, messages: [42] })).toBe(false);
  });

  it('非对象输入 → 拒绝', () => {
    expect(isValidSessionLike(null)).toBe(false);
    expect(isValidSessionLike('x')).toBe(false);
  });
});

describe('toSessionRecord', () => {
  it('完整记录原样保留（messageCount 仍按 messages 重算）', () => {
    const out = toSessionRecord({
      ...base,
      // 下列字段经 cast 进来，模拟备份里带的完整记录。
      ...({
        title: 'Hi',
        model: 'gpt',
        provider: 'openai',
        userInstructions: 'be brief',
        thinkingLevel: 'high',
        messageCount: 999, // 故意错的缓存值
      } as object),
    } as SessionRecordLike);
    expect(out.title).toBe('Hi');
    expect(out.model).toBe('gpt');
    expect(out.provider).toBe('openai');
    expect(out.userInstructions).toBe('be brief');
    expect(out.thinkingLevel).toBe('high');
    // 不信备份的 messageCount，重算 = messages.length。
    expect(out.messageCount).toBe(2);
  });

  it('描述字段缺失 → 补安全默认（thinkingLevel 默认 medium，其余空串）', () => {
    const out = toSessionRecord({ ...base });
    expect(out.title).toBe('');
    expect(out.model).toBe('');
    expect(out.provider).toBe('');
    expect(out.userInstructions).toBe('');
    expect(out.thinkingLevel).toBe('medium');
    expect(out.messageCount).toBe(2);
  });

  it('描述字段类型不对 → 当缺失处理、补默认（不抛错）', () => {
    const out = toSessionRecord({
      ...base,
      ...({ title: 123, model: null, thinkingLevel: {} } as object),
    } as SessionRecordLike);
    expect(out.title).toBe('');
    expect(out.model).toBe('');
    expect(out.thinkingLevel).toBe('medium');
  });

  it('messageCount 永远等于 messages.length（空消息 → 0）', () => {
    const out = toSessionRecord({ ...base, messages: [] });
    expect(out.messageCount).toBe(0);
  });

  it('身份 / 时间字段原样透传，messages 引用不变', () => {
    const out = toSessionRecord({ ...base });
    expect(out.id).toBe(base.id);
    expect(out.createdAt).toBe(1000);
    expect(out.updatedAt).toBe(2000);
    expect(out.messages).toBe(base.messages);
  });
});

// ─── applySessionsTransactional（恢复双写：mutations 直写 vs messages 重建）───

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: 1000 } as unknown as AgentMessage;
}

function messageEntry(id: string, seq: number, parentId: string | null, text: string): Entry {
  return { type: 'message', id, seq, parentId, timestamp: 1000, message: userMessage(text) };
}

/** 带分支的日志：root 下两个子分支（retry 场景），main 指向 b2。 */
function branchyLog(): SessionMutation[] {
  return [
    { kind: 'entry', lane: 'main', entry: messageEntry('root', 1, null, '共同前缀') },
    { kind: 'entry', lane: 'main', entry: messageEntry('b1', 2, 'root', '旧分支') },
    { kind: 'lane', seq: 3, lane: 'main', leafId: 'root' },
    { kind: 'entry', lane: 'main', entry: messageEntry('b2', 4, 'root', '新分支') },
  ];
}

function backupRecord(id: string, overrides: Partial<SessionBackupRecord> = {}): SessionBackupRecord {
  return {
    id,
    createdAt: 1000,
    updatedAt: 2000,
    title: 't',
    model: 'm',
    provider: 'p',
    userInstructions: '',
    thinkingLevel: 'medium',
    messageCount: 0,
    messages: [userMessage('线性回退用')],
    ...overrides,
  };
}

describe('applySessionsTransactional', () => {
  const SID = '6f9619ff-8b86-d011-b42d-00cf4fc964aa';

  beforeEach(async () => {
    await sessionTreeDb.open();
    await sessionTreeDb.table('sessions').clear();
    await sessionTreeDb.table('sessionMutations').clear();
  });

  it('带合法 mutations 的记录直写日志：分支保留、行不存 mutations 字段、messageCount 按日志重算', async () => {
    const record = backupRecord(SID, { mutations: branchyLog() });
    await applySessionsTransactional(() => ({ clearAll: false, toPut: [record] }));

    const rows = await getSessionMutations(SID);
    expect(rows).toHaveLength(4);
    // 分支保留：两个 message entry 都在（b1 在旧分支、b2 在 main）
    const entryIds = rows.flatMap((r) => (r.mutation.kind === 'entry' ? [r.mutation.entry.id] : []));
    expect(entryIds).toEqual(['root', 'b1', 'b2']);
    // 当前 main 分支投影 = 共同前缀 + 新分支
    expect(
      mutationsToMessages(rows.map((r) => r.mutation)).map((m) => (m as { content: string }).content),
    ).toEqual(['共同前缀', '新分支']);

    const row = (await sessionTreeDb.sessions.get(SID))! as SessionRecord & { mutations?: unknown };
    expect('mutations' in row).toBe(false);
    expect(row.messageCount).toBe(3);
  });

  it('mutations 校验失败回退 messages 线性重建（不写半截日志）', async () => {
    const broken: SessionMutation[] = [
      // seq 跳号 → 严格 replay 失败
      { kind: 'entry', lane: 'main', entry: messageEntry('a', 5, null, 'x') },
    ];
    const record = backupRecord(SID, { mutations: broken });
    await applySessionsTransactional(() => ({ clearAll: false, toPut: [record] }));

    const rows = await getSessionMutations(SID);
    // 线性重建：1 条 message entry + 1 条 lane
    expect(rows).toHaveLength(2);
    expect(mutationsToMessages(rows.map((r) => r.mutation)).map((m) => (m as { content: string }).content))
      .toEqual(['线性回退用']);
  });

  it('merge 覆盖同 id：先删旧日志再写新日志，无 seq 残留', async () => {
    await applySessionsTransactional(() => ({
      clearAll: false,
      toPut: [backupRecord(SID, { mutations: branchyLog() })], // 4 行
    }));
    const shorter: SessionMutation[] = [
      { kind: 'entry', lane: 'main', entry: messageEntry('n1', 1, null, '新历史') },
      { kind: 'lane', seq: 2, lane: 'main', leafId: 'n1' },
    ];
    await applySessionsTransactional(() => ({
      clearAll: false,
      toPut: [backupRecord(SID, { updatedAt: 3000, mutations: shorter })],
    }));
    const rows = await getSessionMutations(SID);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]); // 旧 seq 3/4 无残留
  });

  it('entry body 畸形（message 为 null / compaction 缺 retainedTail）→ 校验拒绝并回退重建', async () => {
    const nullMessage: SessionMutation[] = [
      {
        kind: 'entry',
        lane: 'main',
        entry: { type: 'message', id: 'a', seq: 1, parentId: null, timestamp: 1, message: null } as never,
      },
      { kind: 'lane', seq: 2, lane: 'main', leafId: 'a' },
    ];
    const noTail: SessionMutation[] = [
      {
        kind: 'entry',
        lane: 'main',
        entry: {
          type: 'compaction',
          id: 'c',
          seq: 1,
          parentId: null,
          timestamp: 1,
          summary: 's',
          tokensBefore: 1,
        } as never,
      },
    ];
    expect(validateMutationLog(nullMessage)).toBe(false);
    expect(validateMutationLog(noTail)).toBe(false);

    await applySessionsTransactional(() => ({
      clearAll: false,
      toPut: [backupRecord(SID, { mutations: nullMessage })],
    }));
    // 回退到 messages 线性重建，会话可正常投影而非 open 即抛
    const rows = await getSessionMutations(SID);
    expect(mutationsToMessages(rows.map((r) => r.mutation)).map((m) => (m as { content: string }).content))
      .toEqual(['线性回退用']);
  });

  it('replace 清空两表后写入；无 mutations 的 v1 记录走重建', async () => {
    await applySessionsTransactional(() => ({
      clearAll: false,
      toPut: [backupRecord('6f9619ff-8b86-d011-b42d-00cf4fc964bb', { mutations: branchyLog() })],
    }));
    await applySessionsTransactional(() => ({ clearAll: true, toPut: [backupRecord(SID)] }));

    expect(await sessionTreeDb.table('sessions').count()).toBe(1);
    const rows = await getSessionMutations(SID);
    expect(rows).toHaveLength(2); // 线性重建
    expect(await sessionTreeDb.table('sessionMutations').count()).toBe(2); // 旧会话日志被清空
  });
});

describe('validateMutationLog', () => {
  it('合法日志（含分支与 lane 指针）通过；空数组 / seq 跳号 / 悬空 parent 拒绝', () => {
    expect(validateMutationLog(branchyLog())).toBe(true);
    expect(validateMutationLog([])).toBe(false);
    expect(validateMutationLog('nope')).toBe(false);
    expect(
      validateMutationLog([{ kind: 'entry', lane: 'main', entry: messageEntry('a', 2, null, 'x') }]),
    ).toBe(false);
    expect(
      validateMutationLog([{ kind: 'entry', lane: 'main', entry: messageEntry('a', 1, 'missing', 'x') }]),
    ).toBe(false);
  });

  it('未知 kind 拒绝：构造的「未知 kind + 重复 seq」不得通过校验（否则 bulkAdd 撞主键炸掉整个恢复事务）', () => {
    const crafted = [
      { kind: 'weird', seq: 1 },
      { kind: 'entry', lane: 'main', entry: messageEntry('a', 1, null, 'x') },
    ];
    expect(validateMutationLog(crafted)).toBe(false);
    expect(validateMutationLog([{ kind: 'x', seq: 1 }, { kind: 'y', seq: 1 }])).toBe(false);
  });
});

describe('projectMutationLog / sanitizeMutationLog', () => {
  it('坏尾截断：validPrefix 与 messages 出自同一前缀，绝不导出坏尾', () => {
    const log: SessionMutation[] = [
      ...branchyLog(),
      // seq 跳号的坏尾
      { kind: 'entry', lane: 'main', entry: messageEntry('bad', 99, 'b2', '坏') },
    ];
    const { messages, validPrefix } = projectMutationLog(log);
    expect(validPrefix).toHaveLength(4);
    expect(messages.map((m) => (m as { content: string }).content)).toEqual(['共同前缀', '新分支']);
  });

  it('sanitizeMutationLog：脏 message 文本被治愈，干净日志原引用返回', () => {
    const clean = branchyLog();
    expect(sanitizeMutationLog(clean)).toBe(clean);
    const dirty: SessionMutation[] = [
      {
        kind: 'entry',
        lane: 'main',
        entry: {
          type: 'message',
          id: 'd',
          seq: 1,
          parentId: null,
          timestamp: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: null }],
          } as unknown as AgentMessage,
        },
      },
    ];
    const fixed = sanitizeMutationLog(dirty);
    expect(fixed).not.toBe(dirty);
    const entry = fixed[0];
    if (entry.kind !== 'entry' || entry.entry.type !== 'message') throw new Error('unexpected');
    expect((entry.entry.message as { content: { text: string }[] }).content[0].text).toBe('');
  });
});

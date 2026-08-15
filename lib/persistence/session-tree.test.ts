// fake-indexeddb 必须先于任何 Dexie 使用注入全局 indexedDB
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import type { AgentMessage, SessionRepo } from '@earendil-works/pi-agent-core';
import { createSessionBackendConformance } from '@earendil-works/pi-agent-core/session/testing';
import {
  DexieSessionRepo,
  SESSION_META_SCHEMA,
  SESSION_MUTATIONS_SCHEMA,
  type SessionTreeDb,
  type SessionTreeMeta,
} from '@/lib/persistence/session-tree';

function createDb(name: string): SessionTreeDb {
  const db = new Dexie(name) as SessionTreeDb;
  db.version(1).stores({
    sessions: SESSION_META_SCHEMA,
    sessionMutations: SESSION_MUTATIONS_SCHEMA,
  });
  return db;
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } as AgentMessage;
}

// ─── pi 官方后端一致性套件 ───

const conformanceCases = createSessionBackendConformance(async () => {
  const db = createDb(`cebian-tree-conformance-${crypto.randomUUID()}`);
  return {
    // conformance 的泛型基座是 SessionRepo<SessionMetadata>；我们的 meta 是其超集，
    // 运行时兼容（套件只读 id/createdAt/parentSessionId），类型上收窄断言。
    repository: new DexieSessionRepo(db) as unknown as SessionRepo,
    async [Symbol.asyncDispose]() {
      db.close();
      await db.delete();
    },
  };
});

describe('DexieSessionStorage · pi conformance', () => {
  for (const conformanceCase of conformanceCases) {
    it(`${conformanceCase.group} › ${conformanceCase.name}`, () => conformanceCase.run());
  }
});

// ─── Dexie 后端特有行为（conformance 不覆盖：跨实例持久性等） ───

describe('DexieSessionRepo · durability', () => {
  let dbName: string;

  beforeEach(() => {
    dbName = `cebian-tree-test-${crypto.randomUUID()}`;
  });

  it('重放恢复：关库重开后 entries / lanes / name 完整保留（含 entry id 与 timestamp）', async () => {
    const db1 = createDb(dbName);
    const repo1 = new DexieSessionRepo(db1);
    const session1 = await repo1.create({ id: 'persist-me', title: '标题' });
    const rootId = await session1.appendMessage(userMessage('第一条'));
    const childId = await session1.appendMessage(userMessage('第二条'));
    await session1.createLane('alt', rootId);
    await session1.setName('命名');
    const before = await session1.findEntries({ order: 'oldestFirst' });
    db1.close();

    const db2 = createDb(dbName);
    const repo2 = new DexieSessionRepo(db2);
    const session2 = await repo2.open({ id: 'persist-me' } as SessionTreeMeta);
    const after = await session2.findEntries({ order: 'oldestFirst' });
    expect(after).toEqual(before); // id / parentId / seq / timestamp 逐字段一致
    expect(await session2.getLeafId()).toBe(childId);
    expect(await session2.getLanes()).toEqual([
      { lane: 'main', leafId: childId },
      { lane: 'alt', leafId: rootId },
    ]);
    expect(await session2.getName()).toBe('命名');
    // 重开后可继续追加（seq 接续无冲突）
    await expect(session2.appendMessage(userMessage('第三条'))).resolves.toBeTruthy();
    db2.close();
    await db2.delete();
  });

  it('坏尾截断：日志尾部出现非法 mutation 时丢弃坏尾、保留一致前缀，且能继续写', async () => {
    const db1 = createDb(dbName);
    const repo1 = new DexieSessionRepo(db1);
    const session1 = await repo1.create({ id: 'corrupt-tail' });
    const keptId = await session1.appendMessage(userMessage('保留'));
    // 直接注入 seq 跳号的坏行，模拟半截写入
    await db1.sessionMutations.add({
      sessionId: 'corrupt-tail',
      seq: 99,
      mutation: {
        kind: 'entry',
        lane: 'main',
        entry: {
          type: 'message',
          id: 'orphan',
          seq: 99,
          parentId: keptId,
          timestamp: Date.now(),
          message: userMessage('孤儿'),
        },
      },
    });
    db1.close();

    const db2 = createDb(dbName);
    const repo2 = new DexieSessionRepo(db2);
    const session2 = await repo2.open({ id: 'corrupt-tail' } as SessionTreeMeta);
    expect((await session2.findEntries()).map((e) => e.id)).toEqual([keptId]);
    // 坏行已被物理删除，追加取 seq=2 不会撞主键
    await expect(session2.appendMessage(userMessage('新消息'))).resolves.toBeTruthy();
    expect(await db2.sessionMutations.where('sessionId').equals('corrupt-tail').count()).toBe(2);
    db2.close();
    await db2.delete();
  });

  it('元数据维护：追加 message entry 时同步 touch messageCount 与 updatedAt', async () => {
    const db = createDb(dbName);
    const repo = new DexieSessionRepo(db);
    const session = await repo.create({ id: 'meta-touch', title: 't' });
    const created = (await db.sessions.get('meta-touch'))!;
    await session.appendMessage(userMessage('一'));
    await session.appendCustomEntry('marker'); // 非 message entry 不计数
    await session.appendMessage(userMessage('二'));
    const row = (await db.sessions.get('meta-touch'))!;
    expect(row.messageCount).toBe(2);
    expect(row.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    expect(row.title).toBe('t');
    db.close();
    await db.delete();
  });

  it('删除后旧句柄写入报错：不产生孤儿日志行，同 id 重建不撞 seq', async () => {
    const db = createDb(dbName);
    const repo = new DexieSessionRepo(db);
    const session = await repo.create({ id: 'stale-handle' });
    await session.appendMessage(userMessage('将被删'));
    // 不 await：写已入队但未落定时就删除，压 markDeleted → drain → 删行 的竞态路径
    const inflight = session.appendMessage(userMessage('在途写'));
    await repo.delete({ id: 'stale-handle' } as SessionTreeMeta);
    // 在途写在 markDeleted 前已被受理，drain 会等它提交，随后被删行事务清扫
    await expect(inflight).resolves.toBeTruthy();
    await expect(session.appendMessage(userMessage('迟到的写'))).rejects.toMatchObject({
      code: 'storage',
    });
    expect(await db.sessionMutations.where('sessionId').equals('stale-handle').count()).toBe(0);
    // 同 id 重建从 seq=1 重新开始，不与残留行冲突
    const rebuilt = await repo.create({ id: 'stale-handle' });
    await expect(rebuilt.appendMessage(userMessage('新生'))).resolves.toBeTruthy();
    db.close();
    await db.delete();
  });

  it('fork 落盘：分叉出的会话关库重开后 entries / lane / name 与 parentSessionId 保留', async () => {
    const db1 = createDb(dbName);
    const repo1 = new DexieSessionRepo(db1);
    const source = await repo1.create({ id: 'fork-src', title: '源' });
    const rootId = await source.appendMessage(userMessage('根'));
    await source.appendMessage(userMessage('尾'));
    await source.setName('源名');
    const fork = await repo1.fork({ id: 'fork-src' } as SessionTreeMeta, {
      scope: 'branch',
      entryId: rootId,
      position: 'at',
      id: 'fork-dst',
    });
    const before = await fork.findEntries({ order: 'oldestFirst' });
    db1.close();

    const db2 = createDb(dbName);
    const repo2 = new DexieSessionRepo(db2);
    const reopened = await repo2.open({ id: 'fork-dst' } as SessionTreeMeta);
    expect(await reopened.findEntries({ order: 'oldestFirst' })).toEqual(before);
    expect(await reopened.getLeafId()).toBe(rootId);
    expect(await reopened.getName()).toBe('源名');
    expect((await reopened.getMetadata()).parentSessionId).toBe('fork-src');
    // fork 的 lane 指针可继续推进
    await expect(reopened.appendMessage(userMessage('fork 上新增'))).resolves.toBeTruthy();
    db2.close();
    await db2.delete();
  });

  it('list 剥离 v1 遗留字段：带 messages 影子副本的行不把 transcript 泄进元数据', async () => {
    const db = createDb(dbName);
    await db.sessions.add({
      id: 'legacy-row',
      createdAt: 1,
      updatedAt: 2,
      title: '旧会话',
      model: '',
      provider: '',
      userInstructions: '',
      thinkingLevel: 'medium',
      messageCount: 1,
      messages: [userMessage('遗留')],
    } as unknown as SessionTreeMeta);
    const repo = new DexieSessionRepo(db);
    const [meta] = await repo.list();
    expect(meta.id).toBe('legacy-row');
    expect('messages' in meta).toBe(false);
    db.close();
    await db.delete();
  });
});

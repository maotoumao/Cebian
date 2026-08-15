/**
 * 会话树的 Dexie 持久化后端：实现 pi 的 `SessionStorage` / `SessionRepo` 接口，
 * 使 `Session`（pi 的树 API：entry 链、lane 指针、fork）落在 IndexedDB 上。
 *
 * 存储模型（与 pi 的 JSONL 后端同构）：
 * - `sessions` 表：每会话一行元数据（标题 / 模型 / 时间 / messageCount 等），供
 *   会话列表查询排序；transcript 本体不在这里。
 * - `sessionMutations` 表：append-only 的 mutation 日志，复合主键 `[sessionId+seq]`；
 *   打开会话时按 seq 重放进内存 reducer（SessionState）重建树。
 *
 * 一致性约定：每个写操作先落库（单 IDB 事务：日志行 + 元数据 touch），成功后才
 * 推进内存态——落库失败时内存 seq 不前进，内存与磁盘保持一致前缀。写操作经
 * per-session 串行队列执行（IndexedDB 写是异步的，pi conformance 要求并发写的
 * 完成顺序与 seq 顺序一致）。
 *
 * 行为合规由 pi 官方 conformance 套件钉死（见 session-tree.test.ts）。
 */
import Dexie, { type EntityTable, type Table } from 'dexie';
import { Session, SessionError, uuidv7 } from '@earendil-works/pi-agent-core';
import type {
  BranchBounds,
  Entry,
  EntryQuery,
  ForkOptions,
  LanePointer,
  LaneRecord,
  LogItem,
  LogOptions,
  NewRecord,
  OperationStartedRecord,
  ProvisionedEntry,
  RecordQuery,
  SessionCreateOptions,
  SessionMetadata,
  SessionRepo,
  SessionStats,
  SessionStorage,
} from '@earendil-works/pi-agent-core';
import { SessionState, type SessionMutation } from '@/lib/shims/pi-session-state';

// ─── 类型 ───

/** 会话元数据行：树化后 `sessions` 表的形态。描述性字段与旧 `SessionRecord` 同名同义，
 *  transcript 改存 mutations 表；`messageCount` 由存储层随 message entry 落库时维护。 */
interface SessionTreeMeta extends SessionMetadata {
  id: string;
  createdAt: number;
  updatedAt: number;
  parentSessionId?: string;
  title: string;
  model: string;
  provider: string;
  userInstructions: string;
  thinkingLevel: string;
  messageCount: number;
}

/** 建会话时可指定的应用元数据；未给的字段落安全默认。 */
interface SessionTreeCreateOptions extends SessionCreateOptions {
  title?: string;
  model?: string;
  provider?: string;
  userInstructions?: string;
  thinkingLevel?: string;
}

/** mutation 日志行。`seq` 从 mutation 内提出来做复合主键（[sessionId+seq]），
 *  重放按主键序即 seq 序，无需内存排序。 */
interface SessionMutationRow {
  sessionId: string;
  seq: number;
  mutation: SessionMutation;
}

/** 本模块对 Dexie 实例的最小要求。生产侧将在 db.ts 的 `cebian` 库声明这两张表
 *  （迁移子任务落地 v2 schema）；测试可用任意同构临时库。 */
type SessionTreeDb = Dexie & {
  sessions: EntityTable<SessionTreeMeta, 'id'>;
  sessionMutations: Table<SessionMutationRow, [string, number]>;
};

/** Dexie `stores()` 的 schema 片段，db.ts 声明 version 时与测试共用，避免两处漂移。
 *  sessions 的 `updatedAt` 索引被 repo.list() 的排序依赖。 */
const SESSION_META_SCHEMA = 'id, updatedAt';
const SESSION_MUTATIONS_SCHEMA = '[sessionId+seq], sessionId';

// ─── 内部工具 ───

/** 取一条 mutation 的权威 seq（entry/record 内嵌，其余在顶层）。 */
function mutationSeq(mutation: SessionMutation): number {
  return mutation.kind === 'entry'
    ? mutation.entry.seq
    : mutation.kind === 'record'
      ? mutation.record.seq
      : mutation.seq;
}

/** 统计 mutation 日志里 message entry 的数量（= meta 行 messageCount 的口径）。 */
function countMessageEntries(mutations: readonly SessionMutation[]): number {
  let count = 0;
  for (const m of mutations) {
    if (m.kind === 'entry' && m.entry.type === 'message') count++;
  }
  return count;
}

/** 主键冲突（重复 id）——Dexie 把 IDB 的 DOMException 映射为同名 DexieError。 */
function isConstraintError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConstraintError';
}

/** 元数据行 → 对外元数据：剥掉可能残留的 v1 遗留字段（如 `messages` 影子副本）。 */
function rowToMeta(row: SessionTreeMeta & { messages?: unknown }): SessionTreeMeta {
  const { messages: _legacy, ...meta } = row;
  return meta;
}

// ─── Storage ───

class DexieSessionStorage implements SessionStorage<SessionTreeMeta> {
  private readonly state = new SessionState();
  private tail: Promise<unknown> = Promise.resolve();
  private deleted = false;

  private constructor(
    private readonly db: SessionTreeDb,
    // 会话身份快照：跨写入稳定（getMetadata 约定），新鲜的 updatedAt/messageCount 走 repo.list()
    private readonly meta: SessionTreeMeta,
  ) {}

  /** 新建（空树，meta 行由 repo 落库）。 */
  static fresh(db: SessionTreeDb, meta: SessionTreeMeta): DexieSessionStorage {
    return new DexieSessionStorage(db, meta);
  }

  /** 打开既有会话：按 seq 序重放 mutation 日志。SW 猝死可能留下坏尾部（理论上单行
   *  原子写不会，防御性保留）：从首个非法 mutation 起截断并删除残留行，得到一致前缀。 */
  static async load(db: SessionTreeDb, meta: SessionTreeMeta): Promise<DexieSessionStorage> {
    const storage = new DexieSessionStorage(db, meta);
    const rows = await db.sessionMutations
      .where('[sessionId+seq]')
      .between([meta.id, Dexie.minKey], [meta.id, Dexie.maxKey])
      .toArray();
    for (const row of rows) {
      try {
        storage.state.applyMutation(row.mutation);
      } catch (error) {
        console.warn(
          `[session-tree] session ${meta.id} mutation log corrupt at seq ${row.seq}, truncating tail`,
          error,
        );
        await db.sessionMutations
          .where('[sessionId+seq]')
          .between([meta.id, row.seq], [meta.id, Dexie.maxKey])
          .delete();
        break;
      }
    }
    return storage;
  }

  /** repo.delete 后调用：让仍持有本实例的调用方在下一次写入时得到明确错误，
   *  而不是往已删除的会话里写出孤儿日志行。 */
  markDeleted(): void {
    this.deleted = true;
  }

  /** 等待队列中所有已受理的写任务落定（不含之后新入队的）。repo.delete 用
   *  「markDeleted → drain → 删行」关闭"在途写在删除事务之后才提交出孤儿行"的窗口。 */
  drain(): Promise<void> {
    return this.tail.then(
      () => undefined,
      () => undefined,
    );
  }

  fork(meta: SessionTreeMeta, options: ForkOptions): Promise<DexieSessionStorage> {
    return this.enqueue(async () => {
      this.assertAlive();
      const mutations = this.state.createForkMutations(options);
      const forked = new DexieSessionStorage(this.db, {
        ...meta,
        messageCount: countMessageEntries(mutations),
      });
      try {
        await this.db.transaction('rw', this.db.sessions, this.db.sessionMutations, async () => {
          await this.db.sessions.add(forked.meta);
          await this.db.sessionMutations.bulkAdd(
            mutations.map((mutation) => ({
              sessionId: forked.meta.id,
              seq: mutationSeq(mutation),
              mutation,
            })),
          );
        });
      } catch (error) {
        if (isConstraintError(error)) {
          throw new SessionError('already_exists', `Session already exists: ${forked.meta.id}`);
        }
        throw error;
      }
      for (const mutation of mutations) forked.state.applyMutation(mutation);
      return forked;
    });
  }

  async getMetadata(): Promise<SessionTreeMeta> {
    return structuredClone(this.meta);
  }

  async getLanes(): Promise<LanePointer[]> {
    return this.state.getLanes();
  }

  createLane(lane: string, at: string | null): Promise<void> {
    return this.enqueue(async () => {
      this.assertAlive();
      this.state.validateNewLane(lane);
      this.state.validateTarget(at);
      const mutation: SessionMutation = { kind: 'lane', seq: this.state.nextSequence, lane, leafId: at };
      await this.persistMutation(mutation);
      this.state.applyMutation(mutation);
    });
  }

  moveLane(lane: string, to: string | null): Promise<void> {
    return this.enqueue(async () => {
      this.assertAlive();
      this.state.requireLane(lane);
      this.state.validateTarget(to);
      const mutation: SessionMutation = { kind: 'lane', seq: this.state.nextSequence, lane, leafId: to };
      await this.persistMutation(mutation);
      this.state.applyMutation(mutation);
    });
  }

  appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
    return this.enqueue(async () => {
      this.assertAlive();
      const parentId = this.state.requireLane(lane);
      this.state.validateUnusedId(newEntry.id);
      // ProvisionedEntry<TEntry> = Omit<TEntry, 'parentId'|'seq'|'timestamp'>，补齐三字段即
      // 完整 TEntry；tsc 无法对泛型 Omit 反推重组，故经 unknown 断言
      const entry = {
        ...structuredClone(newEntry),
        parentId,
        seq: this.state.nextSequence,
        timestamp: Date.now(),
      } as unknown as TEntry;
      const mutation: SessionMutation = { kind: 'entry', lane, entry };
      await this.persistMutation(mutation, entry.type === 'message' ? 1 : 0);
      this.state.applyMutation(mutation);
      return structuredClone(entry);
    });
  }

  appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): Promise<TRecord> {
    return this.enqueue(async () => {
      this.assertAlive();
      this.state.requireLane(newRecord.lane);
      this.state.validateUnusedId(newRecord.id);
      const currentOpenOperationId = this.state.findOpenOperations(newRecord.lane, { limit: 1 })[0]?.id;
      if (newRecord.type === 'operation_started' && currentOpenOperationId !== undefined) {
        throw new SessionError(
          'storage',
          `Lane ${newRecord.lane} already has an open operation ${currentOpenOperationId}`,
        );
      }
      // 同 appendEntry：NewRecord<TRecord> 补齐 seq/timestamp 即完整 TRecord
      const record = {
        ...structuredClone(newRecord),
        seq: this.state.nextSequence,
        timestamp: Date.now(),
      } as unknown as TRecord;
      const mutation: SessionMutation = { kind: 'record', record };
      await this.persistMutation(mutation);
      this.state.applyMutation(mutation);
      return structuredClone(record);
    });
  }

  async getEntry(id: string): Promise<Entry | undefined> {
    const entry = this.state.getEntry(id);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
    return structuredClone(this.state.findEntries(query));
  }

  async findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]> {
    return structuredClone(this.state.findEntriesOnBranch(query));
  }

  findRecords<K extends LaneRecord['type']>(
    query: RecordQuery & { type: K },
  ): Promise<Extract<LaneRecord, { type: K }>[]>;
  findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
  async findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
    return structuredClone(this.state.findRecords(query));
  }

  async findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]> {
    return structuredClone(this.state.findOpenOperations(lane, options));
  }

  async getLog(options: LogOptions = {}): Promise<LogItem[]> {
    return structuredClone(this.state.getLog(options));
  }

  async getName(): Promise<string | undefined> {
    return this.state.getName();
  }

  setName(name: string): Promise<void> {
    return this.enqueue(async () => {
      this.assertAlive();
      const mutation: SessionMutation = { kind: 'fact', seq: this.state.nextSequence, fact: 'name', name };
      await this.persistMutation(mutation);
      this.state.applyMutation(mutation);
    });
  }

  async getLabel(id: string): Promise<string | undefined> {
    return this.state.getLabel(id);
  }

  setLabel(id: string, label: string | undefined): Promise<void> {
    return this.enqueue(async () => {
      this.assertAlive();
      this.state.validateTarget(id);
      const mutation: SessionMutation = {
        kind: 'fact',
        seq: this.state.nextSequence,
        fact: 'label',
        targetId: id,
        label,
      };
      await this.persistMutation(mutation);
      this.state.applyMutation(mutation);
    });
  }

  async getStats(): Promise<SessionStats> {
    return structuredClone(this.state.getStats());
  }

  /** 写操作串行化：完成顺序 == seq 顺序（conformance 强制），且校验-取号-落库-应用
   *  整段互斥，避免异步落库期间另一写操作取到相同 seq。 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 单 IDB 事务写入日志行并 touch 元数据行（updatedAt / messageCount，供会话列表
   *  排序与预览）。messageCount 是**全树** message entry 数（含被 moveLane 留在
   *  旧分支上的），重试/编辑产生分支后会略大于当前分支长度——列表预览用途可接受，
   *  换取免去每次 append 的整分支遍历。注意只 touch 数据库行、不改本实例的 meta
   *  快照——pi 的约定是 `getMetadata()` 跨写入稳定（conformance 强制），新鲜度走
   *  repo.list()。偶发落库失败（配额、连接抖动）重试一次；仍失败则抛出且不推进
   *  内存态，两侧保持一致前缀。 */
  private async persistMutation(mutation: SessionMutation, messageDelta = 0): Promise<void> {
    const row: SessionMutationRow = { sessionId: this.meta.id, seq: mutationSeq(mutation), mutation };
    const patch = {
      updatedAt: Date.now(),
      messageCount: this.state.getStats().messageCount + messageDelta,
    };
    const write = async () => {
      await this.db.transaction('rw', this.db.sessions, this.db.sessionMutations, async () => {
        await this.db.sessionMutations.add(row);
        await this.db.sessions.update(this.meta.id, patch);
      });
    };
    try {
      await write();
    } catch (error) {
      // 主键冲突是确定性错误（重复 seq / 会话被删后重建撞残留行），重试必然同败；
      // 包成 SessionError 保持本后端错误面的一致性
      if (isConstraintError(error)) {
        throw new SessionError(
          'storage',
          `Mutation seq collision for session ${this.meta.id} at seq ${row.seq}`,
          error instanceof Error ? error : undefined,
        );
      }
      console.warn('[session-tree] mutation write failed, retrying once', error);
      await write();
    }
  }

  private assertAlive(): void {
    if (this.deleted) {
      throw new SessionError('storage', `Session has been deleted: ${this.meta.id}`);
    }
  }
}

// ─── Repo ───

class DexieSessionRepo implements SessionRepo<SessionTreeMeta, SessionTreeCreateOptions, void> {
  /** 已打开的 storage 缓存：同会话多次 open 共享同一实例（与 pi InMemory 后端语义
   *  一致——否则两份内存态各自追加会在日志上撞 seq）。缓存的是 Promise，并发 open
   *  只触发一次重放。 */
  private readonly storages = new Map<string, Promise<DexieSessionStorage>>();

  constructor(private readonly db: SessionTreeDb) {}

  async create(options: SessionTreeCreateOptions = {}): Promise<Session<SessionTreeMeta>> {
    const id = options.id ?? uuidv7();
    const now = Date.now();
    const meta: SessionTreeMeta = {
      id,
      createdAt: now,
      updatedAt: now,
      title: options.title ?? '',
      model: options.model ?? '',
      provider: options.provider ?? '',
      userInstructions: options.userInstructions ?? '',
      thinkingLevel: options.thinkingLevel ?? 'medium',
      messageCount: 0,
      ...(options.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
    };
    // 缓存坑已被占（并发 open / create 抢先）：等占坑者落定再决断——它成功说明
    // 会话已存在（already_exists）；它失败（如 open 了不存在的 id）则坑已被其
    // 自身逐出，走正常创建。保证 create 返回的 storage 一定就是缓存里的实例，
    // 杜绝"同会话两份内存态首次写撞 seq 主键"。
    const occupant = this.storages.get(id);
    if (occupant) {
      try {
        await occupant;
        throw new SessionError('already_exists', `Session already exists: ${id}`);
      } catch (error) {
        if (error instanceof SessionError && error.code === 'already_exists') throw error;
        // 占坑者自身失败——坑已空出，继续创建
      }
    }
    const creating = (async () => {
      try {
        await this.db.sessions.add(meta);
      } catch (error) {
        if (isConstraintError(error)) {
          throw new SessionError('already_exists', `Session already exists: ${id}`);
        }
        throw error;
      }
      return DexieSessionStorage.fresh(this.db, meta);
    })();
    // 先占缓存坑再落行：add 提交后、缓存写入前的窗口里若有并发 open，会 load 出第二份内存态
    this.storages.set(id, creating);
    creating.catch(() => {
      if (this.storages.get(id) === creating) this.storages.delete(id);
    });
    return new Session(await creating);
  }

  async open(metadata: SessionTreeMeta): Promise<Session<SessionTreeMeta>> {
    return new Session(await this.getOrLoad(metadata.id));
  }

  async list(): Promise<SessionTreeMeta[]> {
    const rows = await this.db.sessions.orderBy('updatedAt').reverse().toArray();
    return rows.map(rowToMeta);
  }

  async delete(metadata: SessionTreeMeta): Promise<void> {
    const cached = this.storages.get(metadata.id);
    this.storages.delete(metadata.id);
    if (cached) {
      try {
        const storage = await cached;
        storage.markDeleted();
        // 等在途写落定后再删行，否则它可能在删除事务之后才提交出孤儿日志行，
        // 同 id 重建的会话会在相同 seq 上撞主键
        await storage.drain();
      } catch {
        // 缓存的加载本身失败——没有存活实例需要标记
      }
    }
    await this.db.transaction('rw', this.db.sessions, this.db.sessionMutations, async () => {
      await this.db.sessions.delete(metadata.id);
      await this.db.sessionMutations.where('sessionId').equals(metadata.id).delete();
    });
    // drain 期间并发 open 可能已从仍在盘上的行重新 load 并占坑——那是个从未被
    // markDeleted 的僵尸实例，会让后续 open 返回已删会话。删行事务后回收它。
    const zombie = this.storages.get(metadata.id);
    if (zombie) {
      this.storages.delete(metadata.id);
      try {
        (await zombie).markDeleted();
      } catch {
        // 僵尸加载自身失败——无实例需要标记
      }
    }
  }

  async fork(
    source: SessionTreeMeta,
    options: ForkOptions & SessionTreeCreateOptions = {},
  ): Promise<Session<SessionTreeMeta>> {
    const sourceStorage = await this.getOrLoad(source.id);
    const sourceMeta = await sourceStorage.getMetadata();
    const id = options.id ?? uuidv7();
    const now = Date.now();
    const meta: SessionTreeMeta = {
      id,
      createdAt: now,
      updatedAt: now,
      title: options.title ?? sourceMeta.title,
      model: options.model ?? sourceMeta.model,
      provider: options.provider ?? sourceMeta.provider,
      userInstructions: options.userInstructions ?? sourceMeta.userInstructions,
      thinkingLevel: options.thinkingLevel ?? sourceMeta.thinkingLevel,
      messageCount: 0,
      parentSessionId: options.parentSessionId ?? source.id,
    };
    const forked = await sourceStorage.fork(meta, options);
    this.storages.set(id, Promise.resolve(forked));
    return new Session(forked);
  }

  /** 逐出单个会话的 storage 缓存（不 tombstone——数据仍有效，只是盘上日志被
   *  外部重写，如迁移懒重试）。下次 open 从盘上重放最新日志。 */
  evict(id: string): void {
    this.storages.delete(id);
  }

  /** 清空全部 storage 缓存（备份恢复后调用）。调用方需自行保证没有仍在使用
   *  旧句柄的活 agent（恢复流程的既有限制）。 */
  evictAll(): void {
    this.storages.clear();
  }

  private getOrLoad(id: string): Promise<DexieSessionStorage> {
    const cached = this.storages.get(id);
    if (cached) return cached;
    const loading = (async () => {
      const row = await this.db.sessions.get(id);
      if (!row) throw new SessionError('not_found', `Session not found: ${id}`);
      return DexieSessionStorage.load(this.db, rowToMeta(row));
    })();
    this.storages.set(id, loading);
    loading.catch(() => {
      // 加载失败（如 not_found）不留缓存，下次 open 重新尝试；条件判断防止误逐
      // 后来者（如失败期间 create 已占坑）
      if (this.storages.get(id) === loading) this.storages.delete(id);
    });
    return loading;
  }
}

// ─── Public API ───

export { DexieSessionRepo, SESSION_META_SCHEMA, SESSION_MUTATIONS_SCHEMA, countMessageEntries, mutationSeq };
export type { SessionTreeCreateOptions, SessionTreeDb, SessionTreeMeta, SessionMutationRow };

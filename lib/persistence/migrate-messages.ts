/**
 * v1 线性 transcript → 会话树 mutation 日志的无损转换。
 *
 * 三处共用（保证同一套映射规则）：
 * - db.ts 的 Dexie v1→v2 upgrade（存量会话迁移）；
 * - 备份恢复（v1 格式备份包导入新版本时的转换，见 backup 子任务）；
 * - 测试 fixture 构造。
 *
 * 映射规则（与 lib/agent/session-projection.ts 的投影互为逆变换，round-trip 无损；
 * 例外：compactionSummary 的脏字段——summary 非 string、tokensBefore 非有限数、
 * timestamp 缺失——会被归一化为 '' / 0 / 兜底时间，投影回来与原值不逐字节相等）：
 * - 普通消息（user / assistant / toolResult 及未知自定义 role）→ MessageEntry；
 * - `compactionSummary` 自定义消息 → pi 原生 CompactionEntry（retainedTail 置空：
 *   旧格式里被保留的原文消息本就作为后续成员继续存在，无需 retainedTail 承载）；
 * - `permissionRequest` 自定义消息 → CustomEntry（data = 消息去掉 role；历史数据的
 *   decision 已定格，直接内嵌，不拆 decision entry）；
 * - 末尾一条 lane mutation 把 main 指到最后一个 entry（同 pi fork 的做法：entry
 *   mutation 不带 lane 字段，leaf 由 lane mutation 一次设定）。
 *
 * 必须是**纯同步**函数：Dexie 的 versionchange upgrade 事务里 await 非 IDB 的
 * Promise 会导致 PrematureCommit。
 */
import { uuidv7 } from '@earendil-works/pi-agent-core';
import type { AgentMessage, Entry } from '@earendil-works/pi-agent-core';
import { sanitizeAgentMessages } from '@/lib/agent/message-helpers';
import { entriesToMessages, messageToEntryBody } from '@/lib/agent/session-projection';
import { SessionState, type SessionMutation } from '@/lib/shims/pi-session-state';

/** 消息可能来自脏历史，timestamp 缺失 / 非法时退回给定的兜底值（通常取行的 updatedAt）。 */
function entryTimestamp(msg: AgentMessage, fallback: number): number {
  const t = (msg as { timestamp?: unknown }).timestamp;
  return typeof t === 'number' && Number.isFinite(t) ? t : fallback;
}

function messagesToMutations(messages: AgentMessage[], fallbackTimestamp: number): SessionMutation[] {
  // 先过 issue #43 的形态规整——坏消息一旦冻进 append-only 日志就永久化了
  const sanitized = sanitizeAgentMessages(messages);
  const mutations: SessionMutation[] = [];
  let seq = 0;
  let parentId: string | null = null;
  for (const msg of sanitized) {
    // entry 形态映射与运行时追加共用同一来源（session-projection 的 messageToEntryBody），
    // 迁移只负责补 id / seq / parentId / 历史时间戳
    const entry: Entry = {
      ...messageToEntryBody(msg),
      id: uuidv7(),
      seq: ++seq,
      parentId,
      timestamp: entryTimestamp(msg, fallbackTimestamp),
    };
    mutations.push({ kind: 'entry', entry });
    parentId = entry.id;
  }
  if (parentId !== null) {
    mutations.push({ kind: 'lane', seq: ++seq, lane: 'main', leafId: parentId });
  }
  return mutations;
}

/**
 * 逆向投影：mutation 日志 → 当前 main 分支的线性 `AgentMessage[]`，同时返回可
 * 重放的一致前缀（容错重放：首个非法 mutation 起截断，与 DexieSessionStorage.load
 * 的坏尾语义一致）。备份采集用 `messages` 导出 v1 兼容形态、用 `validPrefix`
 * 随包携带完整日志——绝不导出带坏尾的原始日志（恢复侧的严格校验会整体拒绝，
 * 导致本可保留的分支全部丢失）。
 */
function projectMutationLog(mutations: readonly SessionMutation[]): {
  messages: AgentMessage[];
  validPrefix: SessionMutation[];
} {
  const state = new SessionState();
  const validPrefix: SessionMutation[] = [];
  for (const mutation of mutations) {
    try {
      state.applyMutation(mutation);
    } catch {
      break;
    }
    validPrefix.push(mutation);
  }
  const leafId = state.requireLane('main');
  const messages =
    leafId === null
      ? []
      : entriesToMessages(state.findEntriesOnBranch({ start: leafId, order: 'oldestFirst' }));
  return { messages, validPrefix };
}

/** 只要投影消息的便捷形态。 */
function mutationsToMessages(mutations: readonly SessionMutation[]): AgentMessage[] {
  return projectMutationLog(mutations).messages;
}

/** entry body 的形状校验：SessionState 只管树结构（seq / parent / id），不看 body。
 *  读路径会解引用这些字段（投影取 message.role、compaction 取 retainedTail.length），
 *  畸形 body 一旦写进 append-only 日志会让该会话每次 open 都抛错且无修复路径，
 *  必须挡在写库前（与 isValidSessionLike 对 messages 元素的守卫同责）。 */
function isValidEntryBody(entry: Entry): boolean {
  switch (entry.type) {
    case 'message':
      return entry.message !== null && typeof entry.message === 'object';
    case 'compaction':
      return (
        typeof entry.summary === 'string' &&
        Number.isFinite(entry.tokensBefore) &&
        Array.isArray(entry.retainedTail) &&
        entry.retainedTail.every((m) => m !== null && typeof m === 'object')
      );
    case 'custom':
      return typeof entry.customType === 'string';
    case 'branch_summary':
      return typeof entry.summary === 'string' && typeof entry.fromId === 'string';
    default:
      return true;
  }
}

/**
 * 严格校验一段 mutation 日志：既能完整重放（seq 连续、parent 链闭合、无重复 id，
 * 规则即 SessionState.applyMutation 的全部校验），entry body 也形状合法（见
 * isValidEntryBody）。备份恢复用它决定「直接写入日志（保留分支）」还是「回退用
 * messages 重建（丢分支但保住主干）」——不可信输入宁可降级也不能写进库。
 */
function validateMutationLog(mutations: unknown): mutations is SessionMutation[] {
  if (!Array.isArray(mutations) || mutations.length === 0) return false;
  const state = new SessionState();
  try {
    for (const mutation of mutations as SessionMutation[]) {
      // kind 白名单：未知 kind 在 applyMutation 里是「过 seq 检查但不推进 sequence」
      // 的静默 no-op，会让重复 seq 的构造日志通过校验、随后在 bulkAdd 撞主键炸掉
      // 整个恢复事务——必须在这里显式拒绝，让该记录降级走 messages 重建
      if (
        mutation.kind !== 'entry' &&
        mutation.kind !== 'record' &&
        mutation.kind !== 'lane' &&
        mutation.kind !== 'fact'
      ) {
        return false;
      }
      if (mutation.kind === 'entry' && !isValidEntryBody(mutation.entry)) return false;
      state.applyMutation(mutation);
    }
  } catch {
    return false;
  }
  return true;
}

/** 直写日志前的消息整形（issue #43 防线，与 messagesToMutations 的 sanitize 同责）：
 *  message entry 的消息体与 compaction entry 的 retainedTail 过一遍
 *  sanitizeAgentMessages。copy-on-write：干净日志原样返回同一数组。 */
function sanitizeMutationLog(mutations: SessionMutation[]): SessionMutation[] {
  let out: SessionMutation[] | null = null;
  for (let i = 0; i < mutations.length; i++) {
    const m = mutations[i];
    let fixed = m;
    if (m.kind === 'entry' && m.entry.type === 'message') {
      const [clean] = sanitizeAgentMessages([m.entry.message]);
      if (clean !== m.entry.message) fixed = { ...m, entry: { ...m.entry, message: clean } };
    } else if (m.kind === 'entry' && m.entry.type === 'compaction') {
      const clean = sanitizeAgentMessages(m.entry.retainedTail);
      if (clean !== m.entry.retainedTail) fixed = { ...m, entry: { ...m.entry, retainedTail: clean } };
    }
    if (fixed !== m && out === null) out = mutations.slice(0, i);
    if (out !== null) out.push(fixed);
  }
  return out ?? mutations;
}

// ─── Public API ───

export {
  messagesToMutations,
  mutationsToMessages,
  projectMutationLog,
  sanitizeMutationLog,
  validateMutationLog,
};

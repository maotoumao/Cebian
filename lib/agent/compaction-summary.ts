/**
 * 压缩摘要消息（compactionSummary）的类型增广与纯辅助函数。
 *
 * 从 compaction.ts 拆出来的原因：这些东西被会话投影（lib/agent/session-projection）、
 * 消息迁移（lib/persistence/migrate-messages → db.ts）与 UI 消费，而 compaction.ts 本体
 * 依赖 pi-ai 的模型注册表（约 1 MB）——只想判断「这条消息是不是摘要」的页面（如 VFS 浏览器
 * 经 db.ts 查会话标题）不该为此把整个模型表打进自己的 chunk。本文件只依赖 pi-agent-core 的类型。
 */
import type { AgentMessage, CompactionSummaryMessage } from '@earendil-works/pi-agent-core';

/**
 * 压缩摘要消息：当会话过长触发压缩时，被压缩的历史会被一段 LLM 生成的结构化
 * 摘要替代。这条消息直接作为一条普通成员存在于 `agent.state.messages` 数组里，
 * 跟随正常的持久化 / 广播 / UI 渲染管线，无需改动存储 schema。
 *
 * 落点：树化后摘要是**尾部追加**（压缩发生在新一轮 user 消息进入之前，故摘要
 * 总在「上一轮尾部、本轮 user 之前」），保留区副本挂在 `retainedTail` 上。
 * `truncateForRetry`「截到最后一条 user」天然保住摘要，无需特判。
 *
 * 消息类型直接复用 pi harness 的 `CompactionSummaryMessage`（pi 自身已把它注册进
 * `AgentMessage` union），在此对其做 declaration merging 增广一个字段：
 * - `retainedTail`：压缩时保留区的消息副本（对齐 pi CompactionEntry 的同名字段）。
 *   树化后摘要在会话里是**尾部追加**（不再中段插入），保留区原文位于摘要之前，
 *   LLM 视图由 transformContext 用本字段重建为「摘要 + 保留区 + 其后消息」。
 *   v1 迁移来的旧摘要没有此字段（保留区本就排在摘要之后），两种形态由同一条
 *   transformContext 公式统一处理。UI 渲染忽略此字段。
 */
declare module '@earendil-works/pi-agent-core' {
  interface CompactionSummaryMessage {
    // 语义是 AgentMessage[]，但必须声明为 unknown[]：AgentMessage union 包含本
    // 接口自身，真递归类型会让 Dexie 的 UpdateSpec/KeyPaths 映射类型无限展开
    // （TS2615）。读取统一走下面的 getRetainedTail 拿回具体类型。
    retainedTail?: unknown[];
  }
}

/** 取回 retainedTail 的具体类型（声明层为 unknown[]，见上方注释）；缺失返回 []。 */
function getRetainedTail(msg: CompactionSummaryMessage): AgentMessage[] {
  return (msg.retainedTail as AgentMessage[] | undefined) ?? [];
}

/** 构造一条 compactionSummary 消息。`retainedTail` 见接口注释（新压缩必传，
 *  哪怕保留区为空也传 `[]`；仅 v1 迁移来的历史摘要没有该字段）。 */
function createCompactionSummaryMessage(
  summary: string,
  tokensBefore: number,
  retainedTail: AgentMessage[],
): CompactionSummaryMessage {
  return {
    role: 'compactionSummary',
    summary,
    tokensBefore,
    timestamp: Date.now(),
    retainedTail,
  };
}

/** 类型守卫：判断一条消息是否为 compactionSummary。 */
function isCompactionSummary(
  msg: { role: string },
): msg is CompactionSummaryMessage {
  return msg.role === 'compactionSummary';
}

export { createCompactionSummaryMessage, getRetainedTail, isCompactionSummary };
export type { CompactionSummaryMessage };

// 上下文压缩（compaction）领域类型。压缩逻辑（切点计算、摘要生成、编排）将在
// 后续逐步补充到本文件，先把消息类型与其 AgentMessage union 扩展定义于此，使
// 压缩特性自包含。

/**
 * 压缩摘要消息：当会话过长触发压缩时，被压缩的历史会被一段 LLM 生成的结构化
 * 摘要替代。这条消息直接作为一条普通成员存在于 `agent.state.messages` 数组里，
 * 跟随正常的持久化 / 广播 / UI 渲染管线，无需改动存储 schema。
 *
 * 关键不变式：摘要永远紧挨插在「保留区首条 user 消息」之前（切点对齐 user
 * turn-start），这样 `truncateForRetry` 无需特判即可正确工作。
 *
 * 字段形状对齐 pi harness 的 `CompactionSummaryMessage`：
 * - `summary`：LLM 生成的结构化摘要文本。
 * - `tokensBefore`：压缩前估算的上下文 token 数，仅用于 UI 显示「节省了多少」。
 * - `timestamp`：生成时间（ms）。
 */
export interface CompactionSummaryMessage {
  role: 'compactionSummary';
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

// 通过 pi-agent-core 官方提供的 declaration merging 扩展点，把 compactionSummary
// 注入 `AgentMessage` union，使其成为合法的 AgentMessage 成员（类型安全）。
declare module '@earendil-works/pi-agent-core' {
  interface CustomAgentMessages {
    compactionSummary: CompactionSummaryMessage;
  }
}

/** 构造一条 compactionSummary 消息。 */
export function createCompactionSummaryMessage(
  summary: string,
  tokensBefore: number,
): CompactionSummaryMessage {
  return {
    role: 'compactionSummary',
    summary,
    tokensBefore,
    timestamp: Date.now(),
  };
}

/** 类型守卫：判断一条消息是否为 compactionSummary。 */
export function isCompactionSummary(
  msg: { role: string },
): msg is CompactionSummaryMessage {
  return msg.role === 'compactionSummary';
}

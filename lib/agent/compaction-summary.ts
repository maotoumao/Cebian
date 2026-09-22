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
 * 落点：摘要总是**尾部追加**，保留区副本挂在 `retainedTail` 上。轮首压缩时它落在
 * 「上一轮尾部、本轮 user 之前」，`truncateForRetry`「截到最后一条 user」天然保住它；
 * 轮内压缩（issue #72）则可能落在最后一条 user **之后**，此时 retry 会连它一起切掉——
 * 这是对的，retry 丢弃的是整轮，而摘要摘的正是这一轮的内容。
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
    // 本条不是摘要，而是「早期历史被直接丢弃」的标记：摘要生成失败、而上下文又已
    // 超窗时的兜底（见 createDroppedHistoryMessage）。复用同一消息类型而不是新增一种，
    // 是为了让折叠公式、树持久化、投影、迁移、UI 分隔条这一整条链路原样复用。
    dropped?: true;
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

/**
 * 构造一条「早期历史已被丢弃」的标记，用在压缩的最后一道兜底上。
 *
 * 触发场景：上下文超过了压缩阈值，但摘要生成本身也失败了（最常见的原因是待摘要的
 * 历史本身就比窗口大、摘要请求自己 400，但网络、凭证、限流同样会走到这里）。此前
 * 这种情况会「不插摘要、整段照发」，上下文真的超窗时必然再次 400——会话就此永久
 * 卡死，用户既不能继续也拿不回已经做完的工作，这正是 issue #72 里
 * 「token 消耗了无结果」的那一幕。
 *
 * 这里宁可丢掉早期历史也要让会话能继续：`retainedTail` 照常挂上保留区，折叠公式
 * 与普通摘要完全一致，只是 LLM 侧多一句「更早的内容已被丢弃」的说明
 * （见 {@link renderSummaryForLlm}）。原始消息仍完整留在消息流里可供翻阅。
 *
 * @param carriedSummary 上一段**已经生成成功**的摘要，原样带下去。这一轮失败的是
 *        「把旧摘要和新内容合并成新摘要」，不是「旧摘要作废」；而 `transformContext`
 *        只认最后一条摘要，不带就等于把那段早已压好的历史也一并扔了。旧摘要本身很短
 *        （受 reserveTokens 约束），继续带上几乎不占预算。没有旧摘要时传空串。
 */
function createDroppedHistoryMessage(
  tokensBefore: number,
  retainedTail: AgentMessage[],
  carriedSummary = '',
): CompactionSummaryMessage {
  return {
    role: 'compactionSummary',
    summary: carriedSummary,
    tokensBefore,
    timestamp: Date.now(),
    retainedTail,
    dropped: true,
  };
}

/**
 * 把一条 compactionSummary 渲染成发给 LLM 的那段文本。
 *
 * 抽成纯函数而不是写在 factory 的 `convertToLlm` 闭包里，是为了能直接测：这里守着
 * 一条静默失效的不变式——丢弃标记的 `summary` 可能是空串，一旦漏判 `dropped` 就会发出
 * 一个空的 `<summary></summary>`，等于骗模型说早期上下文已经交代过，而且不会有任何
 * 报错。
 *
 * 三种形态：
 * - 普通摘要 → `<summary>`；
 * - 丢弃标记且带着上一段仍有效的摘要 → `<summary>` + `<context-note>`；
 * - 丢弃标记且没有旧摘要 → 只有 `<context-note>`。
 *
 * 行为指引统一放在标签之外、且措辞一致：别直接回应这段说明，接着后面的消息继续；
 * 只有真的卡住了才回头问用户——否则模型很可能读完注记就先反问一句「丢掉的是什么」，
 * 对用户来说等于换了个形式继续卡住。
 */
function renderSummaryForLlm(msg: CompactionSummaryMessage): string {
  const parts: string[] = [];
  if (msg.summary) parts.push(`<summary>\n${msg.summary}\n</summary>`);
  if (msg.dropped) {
    parts.push(
      '<context-note>\n' +
        'Earlier parts of this conversation were removed because they could not be ' +
        'summarized, so they are no longer available.\n' +
        '</context-note>',
    );
  }
  parts.push(
    'The block above is a compressed record of earlier conversation, provided for ' +
      'context only. Do not respond to it directly; continue with the messages that ' +
      'follow. Only ask the user for a missing detail if it actually blocks you.',
  );
  return parts.join('\n\n');
}

/** 类型守卫：判断一条消息是否为 compactionSummary。 */
function isCompactionSummary(
  msg: { role: string },
): msg is CompactionSummaryMessage {
  return msg.role === 'compactionSummary';
}

export {
  createCompactionSummaryMessage,
  createDroppedHistoryMessage,
  getRetainedTail,
  isCompactionSummary,
  renderSummaryForLlm,
};
export type { CompactionSummaryMessage };

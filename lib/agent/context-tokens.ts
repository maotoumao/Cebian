// 上下文 token 估算：判断「该不该压缩」「从哪里切」时用的那把尺子。
//
// 为什么不直接用 pi 的估算器：pi（`pi-agent-core` 与 `pi-ai` 各有一份）一律按
// `字符数 / 4` 估算，这是英文 BPE 的经验值，对中文低估 2.7–4 倍。issue #72 的现场就是
// 证据——provider 实测 messages 有 1050031 token，而 pi 的估算据此算出「还能再放 333078
// token 的输出」，即它只估出约 71 万。中文页面正文喂进来时，低估会让阈值判断整体失真，
// 压缩要么触发得太晚、要么压完仍然超窗。
//
// 本模块对 CJK 与其他「一字至少一 token」的码点单独计数，按 1 字 1 token 保守估算。
// 宁可高估：高估的代价是多做一次摘要调用，低估的代价是 400 之后会话卡死。
//
// 与 pi 的另一处差异见 `estimateContextTokens`：本模块采用 `pi-ai` 的「前缀时间戳」判据
// 来决定一条 assistant 的 usage 是否还描述得了当前前缀，而不是 `pi-agent-core` 里那种
// 从尾部往前找第一条 assistant 的朴素写法。

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Usage } from '@earendil-works/pi-ai';

/** 非宽字符的经验值，沿用 pi。 */
const CHARS_PER_TOKEN = 4;
/** 一张图片按 pi 的口径折算（pi：4800 字符 / 4）。 */
const IMAGE_TOKENS = 1200;

/**
 * 判断一个码点是否属于「一字至少一 token」的宽字符。
 *
 * 判据不是「长得宽」，而是「UTF-8 至少 3 字节、BPE 下基本不可能压进不到一个 token」。
 * 因此半角假名 / 半角谚文 / 半角符号（`FF61–FFEE`）虽名为半角，仍是三字节字符，**有意**
 * 算作宽字符；星光平面（`>= 0x10000`，含 emoji、CJK 扩展 B 以上、兼容补充）一律算宽，
 * 它们至少四字节，按 1 token 记只会朝保守方向偏。
 *
 * 分区宁可粗一点也不要漏：漏判一段就是 4 倍低估，而多判一段最多让估算偏保守一点。
 */
function isWideCodePoint(cp: number): boolean {
  return (
    // 谚文字母
    (cp >= 0x1100 && cp <= 0x11ff) ||
    // 从「CJK 部首补充」一路连到「统一表意文字」，中间整段都是 CJK 相关区块：
    // 部首补充 / 康熙部首 / 表意描述符 / CJK 符号与标点 / 平假名 / 片假名 / 注音 /
    // 谚文兼容字母 / 汉文训读 / 注音扩展 / CJK 笔画 / 片假名语音扩展 / 带圈 CJK /
    // CJK 兼容 / 扩展 A / 易经六十四卦 / 统一表意文字
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    // 谚文字母扩展 A
    (cp >= 0xa960 && cp <= 0xa97f) ||
    // 谚文音节 + 谚文字母扩展 B
    (cp >= 0xac00 && cp <= 0xd7ff) ||
    // 兼容表意文字
    (cp >= 0xf900 && cp <= 0xfaff) ||
    // 竖排形式（中文排版常见）
    (cp >= 0xfe10 && cp <= 0xfe1f) ||
    // CJK 兼容形式（﹁﹂︰ 一类，繁体内容常见）
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    // 全角 / 半角形式
    (cp >= 0xff00 && cp <= 0xffef) ||
    // 星光平面：emoji、CJK 扩展 B 以上、兼容补充等
    cp >= 0x10000
  );
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '[unserializable]';
  }
}

/** 从 usage 取「本次请求的上下文总量」，口径对齐 pi 的 `calculateContextTokens`。 */
function contextTokensOf(usage: Usage | undefined): number {
  if (!usage) return 0;
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** 一段文本的估算 token 数：宽码点按 1 字 1 token，其余按 4 字 1 token。 */
function estimateTextTokens(text: unknown): number {
  if (typeof text !== 'string') return 0;
  let wide = 0;
  let narrow = 0;
  // 按码点遍历（for...of 走字符串迭代器，代理对只产出一次），否则一个星光平面的字会被
  // 算成两个 char。窄字符累加 `ch.length` 而不是 1：这样即便将来把某段星光平面挪回窄
  // 字符，计价单位仍与 pi 的 UTF-16 `text.length` 一致，不会凭空少一半。
  for (const ch of text) {
    if (isWideCodePoint(ch.codePointAt(0)!)) wide++;
    else narrow += ch.length;
  }
  return wide + Math.ceil(narrow / CHARS_PER_TOKEN);
}

/**
 * 文本 + 图片混合内容（user / toolResult / custom 的 content 形态）的估算。
 *
 * 形参取 `unknown`：`AgentMessage` 是个联合类型，其中 `bashExecution` 等分支没有
 * `content` 字段，索引访问 `AgentMessage['content']` 取不到类型；而 content 在各分支里
 * 的块类型也不一致。这里逐块按结构窄化，并且**不信任字段类型**——历史数据里出现过
 * text 为 null 的坏消息（issue #43），拿它去遍历会直接抛。
 */
function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const block of content as Array<{ type?: string; text?: unknown } | null>) {
    if (!block || typeof block !== 'object') continue;
    // 非文本块一律按图片折算，同 pi：content 数组里除文本外就只有图片。
    tokens += block.type === 'text' ? estimateTextTokens(block.text) : IMAGE_TOKENS;
  }
  return tokens;
}

/** 单条消息的估算 token 数。role 分派移植自 pi 的同名函数，只把尺子换成 CJK 感知的那把。 */
function estimateMessageTokens(message: AgentMessage): number {
  switch (message.role) {
    case 'user':
    case 'toolResult':
    case 'custom':
      return estimateContentTokens(message.content);
    case 'assistant': {
      let tokens = 0;
      for (const block of message.content) {
        if (block.type === 'text') tokens += estimateTextTokens(block.text);
        else if (block.type === 'thinking') tokens += estimateTextTokens(block.thinking);
        else if (block.type === 'toolCall') {
          tokens += estimateTextTokens(block.name) +
            estimateTextTokens(safeJsonStringify(block.arguments));
        }
      }
      return tokens;
    }
    case 'bashExecution':
      return estimateTextTokens(message.command) + estimateTextTokens(message.output);
    case 'branchSummary':
    case 'compactionSummary':
      return estimateTextTokens(message.summary);
    default:
      // Cebian 自己注入 union 的 permissionRequest 落这里。它被 factory 的 convertToLlm
      // 白名单滤掉、根本不进 LLM 视图，估 0 是对的。
      return 0;
  }
}

/**
 * systemPrompt + 工具 schema 的估算量。
 *
 * 工具表整份 JSON 序列化后按文本估——`execute` 之类的函数字段会被 JSON.stringify 丢掉，
 * 剩下的 name / description / parameters 正是真正发给 provider 的部分。Cebian 接上 MCP 后
 * 这份 schema 可达上万 token，漏算会让新会话的阈值判断明显偏低。
 */
function estimatePrefixTokens(systemPrompt: string | undefined, tools: unknown[] | undefined): number {
  const toolTokens = !tools || tools.length === 0 ? 0 : estimateTextTokens(safeJsonStringify(tools));
  return estimateTextTokens(systemPrompt) + toolTokens;
}

/**
 * 待估算的上下文。形状对齐 pi-ai 的 `Context`：把 systemPrompt / tools 一并交进来，
 * 「它们只在没有 usage 锚点时才计入」这条规则就收在模块内部，调用方不必知道——也顺带
 * 省掉有锚点（常态）时白算一遍整张工具表 JSON 的开销。
 */
export interface ContextSnapshot {
  /** LLM 视图形态的消息序列（摘要折叠后的那一份，不是 state 全量）。 */
  messages: AgentMessage[];
  systemPrompt?: string;
  /** `agent.state.tools`。序列化后按文本估，见 `estimatePrefixTokens`。 */
  tools?: unknown[];
}

/** {@link estimateContextTokens} 的结果，字段与 pi 的 `ContextUsageEstimate` 同名同义。 */
export interface ContextTokenEstimate {
  /** 估算的上下文总 token。 */
  tokens: number;
  /** 取自 provider 真实 usage 的部分；无可用锚点时为 0。 */
  usageTokens: number;
  /** 锚点之后（或无锚点时的全部）按字符估算的部分。 */
  trailingTokens: number;
  /** 提供 usage 的那条消息下标；无锚点为 null。 */
  lastUsageIndex: number | null;
}

/**
 * 估算一段上下文的占用：能用 provider 回报的真实 usage 就用它当锚点，锚点之后的尾巴才
 * 按字符估算；没有锚点时全量估算并叠加 systemPrompt + 工具 schema（有锚点时这些已经含在
 * usage 里了，不再重复计入）。
 *
 * 哪条 assistant 的 usage 还算数，判据有三条（前两条同 pi，第三条是 `pi-ai` 有、
 * `pi-agent-core` 没有的那条，本模块跟 `pi-ai`）：
 * 1. `stopReason` 不是 `aborted` 也不是 `error`——这两种情况请求没有正常完成，usage
 *    描述不了一个真实发出去的前缀。issue #72 里那条 400 失败的 assistant 正属此列。
 * 2. usage 折算出的上下文 > 0（缺 usage 字段的历史消息按 0 处理，不抛）。
 * 3. **它的时间戳不早于在它之前出现过的任何一条消息**。压缩摘要是尾部追加的（时间戳最新），
 *    而它前面挂着的 `retainedTail` 是压缩时的旧消息——若不看时间戳，刚压完的那一轮会
 *    读到 retainedTail 里那条「压缩前的巨大 usage」，误判成仍然超阈值而立刻再压一次。
 *
 * 有意省略 pi-ai 的一处逻辑：它在有锚点时会补算 `addedToolNames` 引入的新工具 schema。
 * Cebian 不用延迟工具加载（全仓无 `addedToolNames` 生产者），省略等价。
 */
function estimateContextTokens(context: ContextSnapshot): ContextTokenEstimate {
  const { messages } = context;
  let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
  let anchor: { usage: Usage; index: number } | undefined;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (
      message.role === 'assistant' &&
      message.stopReason !== 'aborted' &&
      message.stopReason !== 'error' &&
      contextTokensOf(message.usage) > 0 &&
      message.timestamp >= latestPrefixTimestamp
    ) {
      anchor = { usage: message.usage, index: i };
    }
    latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
  }

  if (!anchor) {
    let estimated = estimatePrefixTokens(context.systemPrompt, context.tools);
    for (const message of messages) estimated += estimateMessageTokens(message);
    return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
  }

  const usageTokens = contextTokensOf(anchor.usage);
  let trailingTokens = 0;
  for (let i = anchor.index + 1; i < messages.length; i++) {
    trailingTokens += estimateMessageTokens(messages[i]);
  }
  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex: anchor.index,
  };
}

// ─── Public API ───

export { estimateContextTokens, estimateMessageTokens, estimateTextTokens };

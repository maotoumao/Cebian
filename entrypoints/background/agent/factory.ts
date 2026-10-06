// Cebian 的 Agent 工厂：把 pi-agent-core 的 `Agent` 按本项目的约定配好（LLM 消息
// 转换、上下文窗口折叠、stream 函数、凭证解析、工具执行前门禁）并实例化。
//
// 契约：本工厂是**agentic loop 的唯一入口**，而不是「所有 LLM 调用的入口」。
// 判据是是否需要「模型 → 工具 → 模型」的自主循环：
//   - 需要循环 → 走这里。工具集、消息状态、事件订阅、取消语义、上下文窗口管理
//     五样东西会一并跟来，绕过就意味着复制它们（主对话、记忆整理属此类）。
//   - 一次性文本变换（总结、翻译、解释）→ 直接调 pi 的 `stream` / `generateSummary`，
//     不要套 Agent：那要造空工具数组、订阅事件、管 state.messages、等 agent_end
//     才拿得到结果，纯负担（压缩、划词动作属此类，现状正确）。
//
// 不负责提示词拼接：成形的 systemPrompt 由同目录 `prompt-composer.ts` 产出后传入。
// 谁在用：会话（chat）与临时整理 agent（memory）——本文件对两者都不知情。

import {
  Agent,
  type AgentContext,
  type AgentMessage,
  type AgentOptions,
  type AgentTool,
} from '@earendil-works/pi-agent-core';
import {
  createInitialSystemMessage,
  toToolDeclaration,
  type Api,
  type Message,
  type Model,
} from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { ThinkingLevel } from '@/lib/persistence/storage';
import { resolveProviderApiKey } from '../providers/credentials';
import {
  getRetainedTail,
  isCompactionSummary,
  renderSummaryForLlm,
  type CompactionSummaryMessage,
} from '@/lib/agent/compaction-summary';
import { sanitizeAgentMessages } from '@/lib/agent/message-helpers';
import { supportsToolCalling } from '@/lib/providers/custom-models';
import { toPlainChat } from './plain-chat';
import { NO_TOOLS_NOTE } from './system-prompt';

// ─── System 头 ───

/**
 * 每次请求前注入为首条 system 消息的系统提示词与工具集。
 *
 * 调用方持有这个对象并可随时改写字段（会话刷新提示词、MCP 增删工具），下一次请求即生效，
 * 包括 run 进行中的下一个 turn。
 */
interface AgentPreamble {
  /**
   * 完整成形的 systemPrompt（base + skills + user-instructions 已拼好）。由调用方
   * 经同目录 `prompt-composer.ts` 导出的 `composeSystemPrompt`（其内委托纯函数
   * `buildSystemPrompt`）组装后传入——本工厂不自行拼接。
   */
  systemPrompt: string;
  /** 本 agent 可执行、并声明给模型的工具（会话的含 per-session ask_user）。 */
  tools: AgentTool<any>[];
}

/**
 * 去掉 context 里的 system 消息，并清空工具集。
 *
 * pi 1.0 的 loop 在每次请求前比对「transcript 里 system 消息声明的工具」与
 * `context.tools`，不一致就往 transcript 插一条声明工具变更的 system 消息——它会经
 * message_end 进入 `state.messages`、落树、广播。两边同时为空即永远一致，loop 就不会插。
 */
function withoutPreamble(context: AgentContext): AgentContext {
  return { messages: context.messages.filter((m) => m.role !== 'system'), tools: [] };
}

/** 已报过同名冲突的工具数组，避免每次请求重复告警。 */
const warnedToolArrays = new WeakSet<AgentTool<any>[]>();

/**
 * 按工具名去重，保留先出现的那个（loop 执行工具调用时按名 `find`，命中的也是第一个）。
 *
 * 同名工具的声明不同时会破坏头与工具集的一致性：transcript 侧按名折叠后的声明与
 * `context.tools` 对不上，loop 便认定工具有变更、每个 turn 往 `state.messages` 插 system 消息。
 * 同名来自 MCP：工具名截断后撞前缀，或两个服务器名 slug 相同。
 */
function uniqueByName(tools: AgentTool<any>[]): AgentTool<any>[] {
  const seen = new Set<string>();
  const dropped: string[] = [];
  const unique = tools.filter((tool) => {
    if (seen.has(tool.name)) {
      dropped.push(tool.name);
      return false;
    }
    seen.add(tool.name);
    return true;
  });
  if (dropped.length > 0 && !warnedToolArrays.has(tools)) {
    warnedToolArrays.add(tools);
    console.warn('[agent] duplicate tool names, keeping the first of each:', dropped);
  }
  return unique;
}

/**
 * 在请求前给 context 装上 system 头：首条 system 消息承载提示词与工具声明，
 * `context.tools` 同步为同一组工具（loop 执行工具调用时查它）。头与工具集一致，loop
 * 不会再插工具变更消息。先剥掉旧头再装，重复调用结果相同。
 *
 * 本次请求的模型关掉了工具调用时（#83）：头里不声明任何工具、提示词末尾说明没有工具可用；
 * 历史里的工具调用由 convertToLlm 改写成纯文本（见 createCebianAgent）。
 */
function withPreamble(context: AgentContext, preamble: AgentPreamble, model: Model<Api>): AgentContext {
  const { messages } = withoutPreamble(context);
  const { systemPrompt, tools } = requestPreamble(preamble, model);
  const head = createInitialSystemMessage(systemPrompt, tools.map(toToolDeclaration));
  return { messages: head ? [head, ...messages] : messages, tools };
}

/**
 * 某个模型的请求实际发出的系统提示词与工具：关掉工具调用的模型（#83）不声明任何工具，
 * 提示词末尾追加 {@link NO_TOOLS_NOTE}。请求组装与上下文用量估算都走这里，两边口径一致。
 */
function requestPreamble(preamble: AgentPreamble, model: Model<Api>): AgentPreamble {
  if (!supportsToolCalling(model)) {
    return { systemPrompt: `${preamble.systemPrompt}\n\n${NO_TOOLS_NOTE}`, tools: [] };
  }
  return { systemPrompt: preamble.systemPrompt, tools: uniqueByName(preamble.tools) };
}

// ─── Agent factory ───

interface CreateAgentOptions {
  model: Model<Api>;
  /** 系统提示词与工具集，见 {@link AgentPreamble}。工厂只读不写。 */
  preamble: AgentPreamble;
  thinkingLevel: ThinkingLevel;
  messages?: AgentMessage[];
  /**
   * Optional pre-execution gate. pi-agent-core calls it after a tool's args
   * are validated and before `execute()`; returning `{ block: true, reason }`
   * blocks the call and emits an error tool result. Used to require user
   * authorization before certain tools run (see `lib/agent/tool-permissions.ts`).
   */
  beforeToolCall?: AgentOptions['beforeToolCall'];
  /**
   * 每完成一个 turn、发起下一次请求之前调用，可返回替换后的 context。会话用它做
   * **轮内压缩**——压缩此前只在新一轮 user 消息之前做，单轮内跑上百次工具调用的会话
   * 一次都轮不到（issue #72）。pi 明确为长耗时准备工作留了这个钩子。
   */
  prepareNextTurnWithContext?: AgentOptions['prepareNextTurnWithContext'];
  /**
   * 每个 turn 的助手消息与工具结果都已产出、`turn_end` 之前调用，返回
   * `{ action: 'end' }` 则在 `turn_end` 后收尾本次 run（排在
   * `prepareNextTurnWithContext` 之前）。会话用它在「上下文到顶却压不动」时主动停轮，
   * 把控制权交回用户，而不是继续跑到 provider 返回 400。注意 error / aborted 的 turn
   * 也会调用它（返回值被忽略），有副作用的实现要自行跳过。
   */
  finishTurn?: AgentOptions['finishTurn'];
}

function createCebianAgent(options: CreateAgentOptions): Agent {
  const {
    model,
    preamble,
    thinkingLevel,
    messages = [],
    beforeToolCall,
    prepareNextTurnWithContext,
    finishTurn,
  } = options;

  // 本次请求的模型能否调用工具：prepareRequest 记下，同一次请求随后的 convertToLlm 据此决定
  // 是否改写成纯对话（#83）。loop 对每次请求按 prepareRequest → transformContext →
  // convertToLlm 的顺序依次调用，convertToLlm 自己拿不到模型，所以经这个变量传过去。
  let plainChat = false;

  const agentOptions: AgentOptions = {
    // 系统提示词与工具都不进 initialState：pi 1.0 会把它们折成 `state.messages` 开头的
    // 一条 system 消息，随之落树、广播、错开树的下标对齐表。这里让 `state.messages`
    // 只装对话本身，system 头由下面的 prepareRequest 在每次请求前现装。
    initialState: {
      model,
      thinkingLevel,
      messages,
    },

    // 每次请求前（含每个 run 的首次）装上 system 头。返回的 context 会替换 loop 本次及
    // 之后请求所用的 context，所以 run 中途改写的 preamble 在下一个 turn 生效。
    prepareRequest: ({ context, model: requestModel }) => {
      plainChat = !supportsToolCalling(requestModel);
      return { context: withPreamble(context, preamble, requestModel) };
    },

    // 把 AgentMessage 转换为发给 LLM 的 Message。compactionSummary 降级成一条 user
    // 消息（文本由 renderSummaryForLlm 渲染），其余自定义类型一律过滤掉，只保留
    // system（prepareRequest 装的头）/ user / assistant / toolResult。模型关掉了工具调用时
    // 再改写成不含工具协议的纯对话。
    convertToLlm: (msgs: AgentMessage[]): Message[] => {
      const out: Message[] = [];
      // 送入 pi 前把消息整形回类型契约（null text/thinking/name → ''）。否则 pi 的 token
      // 估算器（clampMaxTokensToContext）对 assistant 块无保护地取 .length，一旦历史里有
      // 这类坏消息就会整轮抛「reading 'length'」（issue #43）
      for (const m of sanitizeAgentMessages(msgs)) {
        if (isCompactionSummary(m)) {
          // 摘要 / 丢弃标记的文本形态统一由 renderSummaryForLlm 决定（纯函数，有单测守着
          // 「空摘要不能发成 <summary></summary>」这条静默不变式）。
          out.push({ role: 'user', content: renderSummaryForLlm(m), timestamp: m.timestamp });
          continue;
        }
        if (['system', 'user', 'assistant', 'toolResult'].includes((m as Message).role)) {
          out.push(m as Message);
        }
      }
      return plainChat ? toPlainChat(out) : out;
    },

    // 上下文窗口管理：若存在压缩摘要，LLM 视图 = 最后一条摘要 + 其保留区副本
    // （retainedTail）+ 其后的全部消息——摘要之前的历史已被摘要覆盖，无需再发。
    // 两种摘要形态由同一条公式统一处理：
    // - 新压缩（树化后）：摘要尾部追加，保留区原文在摘要**之前**、副本挂在
    //   retainedTail 上 → 公式展开副本；
    // - v1 迁移来的旧摘要：无 retainedTail（保留区本就在摘要之后）→ 公式退化为
    //   原来的「从摘要起切片」。
    // state.messages 仍保留完整历史（无损），此处只是 LLM 边界的视图变换，不写回 state。
    // system 头不属于被折叠的历史，始终留在最前。
    transformContext: async (msgs: AgentMessage[]): Promise<AgentMessage[]> => {
      let lastSummaryIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (isCompactionSummary(msgs[i])) {
          lastSummaryIdx = i;
          break;
        }
      }
      if (lastSummaryIdx < 0) return msgs;
      const summary = msgs[lastSummaryIdx] as CompactionSummaryMessage;
      const head = msgs.filter((m) => m.role === 'system');
      return [...head, summary, ...getRetainedTail(summary), ...msgs.slice(lastSummaryIdx + 1)];
    },

    // 发送 LLM 请求的 stream 函数。pi 0.81 起 streamFn 必填（内置默认回退被移除），
    // 复用 compat 的 streamSimple：按 model.api 解析内置 provider，行为等价旧默认，
    // apiKey 仍由下面的 getApiKey 动态解析
    streamFn: streamSimple,

    // Dynamic API key resolution (handles OAuth token refresh)
    getApiKey: (provider: string): Promise<string | undefined> =>
      resolveProviderApiKey(provider),

    // 工具执行前授权门禁（可选）。permissionRequest 自定义消息无需在
    // convertToLlm 里特判——上面的角色白名单已把它连同其它自定义类型一并过滤，
    // 不会发给 provider。
    beforeToolCall,

    // 轮内的上下文管理：先判停轮、再做压缩（pi 的 loop 顺序就是
    // `finishTurn → turn_end → prepareNextTurn → prepareRequest → 下一次请求`）。
    ...(finishTurn ? { finishTurn } : {}),
    // 调用方返回的 context 是从带 system 头的 context 派生的；剥掉头、清空工具集，交回
    // 「无头无工具」的一致状态，紧接着的 prepareRequest 会按当前 preamble 重新装头。
    ...(prepareNextTurnWithContext
      ? {
          prepareNextTurnWithContext: async (turn, signal) => {
            const update = await prepareNextTurnWithContext(turn, signal);
            return update?.context ? { ...update, context: withoutPreamble(update.context) } : update;
          },
        }
      : {}),
  };

  return new Agent(agentOptions);
}

// ─── 公开 API ───

export { createCebianAgent, requestPreamble, type AgentPreamble, type CreateAgentOptions };

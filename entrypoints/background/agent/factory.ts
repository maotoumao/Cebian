// Cebian 的 Agent 工厂：把 pi-agent-core 的 `Agent` 按本项目的约定配好（LLM 消息
// 转换、上下文窗口折叠、stream 函数、凭证解析、工具执行前门禁）并实例化。
//
// 不负责提示词拼接：成形的 systemPrompt 由同目录 `prompt-composer.ts` 产出后传入。
// 谁在用：会话（chat）与临时整理 agent（memory）——本文件对两者都不知情。

import { Agent, type AgentOptions, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import type { Api, Model, Message } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { ThinkingLevel } from '@/lib/persistence/storage';
import { resolveProviderApiKey } from '../providers/credentials';
import { isCompactionSummary } from '@/lib/agent/compaction';
import { sanitizeAgentMessages } from '@/lib/agent/message-helpers';

// ─── Agent factory ───

interface CreateAgentOptions {
  model: Model<Api>;
  /**
   * 完整成形的 systemPrompt（base + skills + user-instructions 已拼好）。由调用方
   * 经同目录 `prompt-composer.ts` 导出的 `composeSystemPrompt`（其内委托纯函数
   * `buildSystemPrompt`）组装后传入——本工厂不再自行拼接，避免「先拼一版、马上
   * 被含 skills 的版本覆盖」的双读双设。
   */
  systemPrompt: string;
  thinkingLevel: ThinkingLevel;
  messages?: AgentMessage[];
  /** Session-specific tools array (includes per-session ask_user). */
  tools: AgentTool<any>[];
  /**
   * Optional pre-execution gate. pi-agent-core calls it after a tool's args
   * are validated and before `execute()`; returning `{ block: true, reason }`
   * blocks the call and emits an error tool result. Used to require user
   * authorization before certain tools run (see `lib/agent/tool-permissions.ts`).
   */
  beforeToolCall?: AgentOptions['beforeToolCall'];
}

function createCebianAgent(options: CreateAgentOptions): Agent {
  const {
    model,
    systemPrompt,
    thinkingLevel,
    messages = [],
    tools: agentTools,
    beforeToolCall,
  } = options;

  const agentOptions: AgentOptions = {
    initialState: {
      systemPrompt,
      model,
      thinkingLevel,
      tools: agentTools,
      messages,
    },

    // 把 AgentMessage 转换为发给 LLM 的 Message。compactionSummary 降级成一条
    // user 消息（用 <summary> 包裹 + 一句「仅供参考、勿直接回应」），其余自定义
    // 类型一律过滤掉，只保留 user / assistant / toolResult。
    convertToLlm: (msgs: AgentMessage[]): Message[] => {
      const out: Message[] = [];
      // 送入 pi 前把消息整形回类型契约（null text/thinking/name → ''）。否则 pi 的 token
      // 估算器（clampMaxTokensToContext）对 assistant 块无保护地取 .length，一旦历史里有
      // 这类坏消息就会整轮抛「reading 'length'」（issue #43）
      for (const m of sanitizeAgentMessages(msgs)) {
        if (isCompactionSummary(m)) {
          out.push({
            role: 'user',
            content:
              `<summary>\n${m.summary}\n</summary>\n\n` +
              'The block above is a compressed summary of earlier conversation, ' +
              'provided for context only. Do not respond to it directly; ' +
              'continue with the messages that follow.',
            timestamp: m.timestamp,
          });
          continue;
        }
        if (['user', 'assistant', 'toolResult'].includes((m as Message).role)) {
          out.push(m as Message);
        }
      }
      return out;
    },

    // 上下文窗口管理：若存在压缩摘要，则只把「最后一条摘要 + 其后的全部消息」
    // 送给 LLM——摘要之前的历史已被该摘要覆盖，无需再发。state.messages 仍保留
    // 完整历史（无损），此处只是 LLM 边界的视图变换，不写回 state。
    transformContext: async (msgs: AgentMessage[]): Promise<AgentMessage[]> => {
      let lastSummaryIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (isCompactionSummary(msgs[i])) {
          lastSummaryIdx = i;
          break;
        }
      }
      if (lastSummaryIdx < 0) return msgs;
      return msgs.slice(lastSummaryIdx);
    },

    // 发送 LLM 请求的 stream 函数。pi 0.81 起 streamFn 必填（内置默认回退被移除），
    // 复用 compat 的 streamSimple：按 model.api 解析内置 provider，行为等价旧默认，
    // apiKey 仍由下面的 getApiKey 动态解析
    streamFn: streamSimple,

    // Dynamic API key resolution (handles OAuth token refresh)
    getApiKey: (provider: string): Promise<string | undefined> =>
      resolveProviderApiKey(provider),

    // 工具执行前授权门禁（可选）。permissionRequest 自定义消息无需在
    // convertToLlm 里特判——上面的 user/assistant/toolResult 白名单已把它
    // 连同其它自定义类型一并过滤，不会发给 provider。
    beforeToolCall,
  };

  return new Agent(agentOptions);
}

// ─── 公开 API ───

export { createCebianAgent, type CreateAgentOptions };

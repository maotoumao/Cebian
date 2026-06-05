import { Agent, type AgentOptions, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import type { Api, Model, Message } from '@earendil-works/pi-ai';
import { providerCredentials, type OAuthCredential } from './storage';
import { getValidOAuthToken } from './oauth';
import { DEFAULT_SYSTEM_PROMPT } from './constants';
import { isCompactionSummary } from './compaction';

// ─── Provider credential resolution ───

/**
 * 解析某个 provider 的有效 API key：`apiKey` 凭证直接返回；`oauth` 凭证走
 * `getValidOAuthToken`（含自动刷新）。供 agent 的 `getApiKey` 与压缩流程
 * （agent-manager 的独立 `generateSummary` 调用）共用，避免两处复制凭证解析逻辑。
 */
export async function resolveProviderApiKey(
  provider: string,
): Promise<string | undefined> {
  try {
    const creds = await providerCredentials.getValue();
    const cred = creds[provider];
    if (!cred) return undefined;

    if (cred.authType === 'apiKey') {
      return cred.apiKey;
    }

    if (cred.authType === 'oauth') {
      return getValidOAuthToken(provider, cred as OAuthCredential);
    }
  } catch (err) {
    console.error(`[Agent] Failed to get API key for ${provider}:`, err);
  }
  return undefined;
}

// ─── System prompt builder ───

/**
 * 构造 agent 的 systemPrompt：基础提示词（替换 `{{SESSION_ID}}`）+ 可选的
 * `<user-instructions>` 段。作为 systemPrompt 的单一真理来源，供
 * `createCebianAgent`（建 agent 时）与 retry 的原地刷新（用户中途改了指令时）
 * 共用，避免两处复制拼接逻辑。
 */
export function buildSystemPrompt(sessionId: string, userInstructions: string): string {
  const basePrompt = DEFAULT_SYSTEM_PROMPT.replaceAll('{{SESSION_ID}}', sessionId);
  const trimmedInstructions = userInstructions.trim();
  return trimmedInstructions
    ? `${basePrompt}\n\n<user-instructions>\n${trimmedInstructions}\n</user-instructions>`
    : basePrompt;
}

// ─── Agent factory ───

export interface CreateAgentOptions {
  model: Model<Api>;
  /** Session id — substituted into the system prompt as the agent's working directory. */
  sessionId: string;
  /**
   * Optional user-provided instructions appended to the built-in system prompt.
   * Intended for style/language/role tweaks; cannot override tool protocol or safety rules.
   */
  userInstructions: string;
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high';
  messages?: AgentMessage[];
  /** Session-specific tools array (includes per-session ask_user). */
  tools: AgentTool<any>[];
}

export function createCebianAgent(options: CreateAgentOptions): Agent {
  const {
    model,
    sessionId,
    userInstructions,
    thinkingLevel,
    messages = [],
    tools: agentTools,
  } = options;

  const effectivePrompt = buildSystemPrompt(sessionId, userInstructions);

  const agentOptions: AgentOptions = {
    initialState: {
      systemPrompt: effectivePrompt,
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
      for (const m of msgs) {
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

    // Dynamic API key resolution (handles OAuth token refresh)
    getApiKey: (provider: string): Promise<string | undefined> =>
      resolveProviderApiKey(provider),
  };

  return new Agent(agentOptions);
}

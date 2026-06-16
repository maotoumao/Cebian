import { Agent, type AgentOptions, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import type { Api, Model, Message } from '@earendil-works/pi-ai';
import { providerCredentials, type OAuthCredential } from '@/lib/persistence/storage';
import { getValidOAuthToken } from '@/lib/providers/oauth';
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/agent/system-prompt';
import { isCompactionSummary } from '@/lib/agent/compaction';

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
 * `<skills>`（skills 索引）段 + 可选的 `<user-instructions>` 段。作为
 * systemPrompt 拼接的单一真理来源，由 agent-manager 的 `composeSystemPrompt`
 * 在会话创建 / 切模型 / retry / 每轮派发前刷新时调用。
 *
 * 保持纯/同步：skills 与 instructions 的数据获取留在 agent-manager（它本就
 * import 了 scanner），本函数只负责拼接，不依赖 VFS / scanner。
 *
 * skills 块置于 system 顶部（贴近 base prompt），随整个 system 落入缓存前缀——
 * skills 不变则逐字节一致、每轮命中缓存；skills 变则击穿一次（装/卸 skill 的
 * 实时性代价，低频可接受）。system 末尾只有一个缓存断点，skills 与 instructions
 * 谁先谁后不影响命中率，顺序仅取语义可读性。
 */
export function buildSystemPrompt(
  sessionId: string,
  userInstructions: string,
  skillsBlock?: string,
): string {
  const basePrompt = DEFAULT_SYSTEM_PROMPT.replaceAll('{{SESSION_ID}}', sessionId);
  const parts: string[] = [basePrompt];

  const trimmedSkills = skillsBlock?.trim();
  if (trimmedSkills) {
    parts.push(trimmedSkills);
  }

  const trimmedInstructions = userInstructions.trim();
  if (trimmedInstructions) {
    parts.push(`<user-instructions>\n${trimmedInstructions}\n</user-instructions>`);
  }

  return parts.join('\n\n');
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
  /**
   * Optional pre-execution gate. pi-agent-core calls it after a tool's args
   * are validated and before `execute()`; returning `{ block: true, reason }`
   * blocks the call and emits an error tool result. Used to require user
   * authorization before certain tools run (see `lib/agent/tool-permissions.ts`).
   */
  beforeToolCall?: AgentOptions['beforeToolCall'];
}

export function createCebianAgent(options: CreateAgentOptions): Agent {
  const {
    model,
    sessionId,
    userInstructions,
    thinkingLevel,
    messages = [],
    tools: agentTools,
    beforeToolCall,
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

    // 工具执行前授权门禁（可选）。permissionRequest 自定义消息无需在
    // convertToLlm 里特判——上面的 user/assistant/toolResult 白名单已把它
    // 连同其它自定义类型一并过滤，不会发给 provider。
    beforeToolCall,
  };

  return new Agent(agentOptions);
}

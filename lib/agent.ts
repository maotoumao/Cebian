import { Agent, type AgentOptions, type AgentMessage, type AgentTool } from '@mariozechner/pi-agent-core';
import type { Api, Model, Message } from '@mariozechner/pi-ai';
import { providerCredentials, type OAuthCredential } from './storage';
import { getValidOAuthToken } from './oauth';
import { DEFAULT_SYSTEM_PROMPT } from './constants';

// ─── Agent factory ───

export interface CreateAgentOptions {
  model: Model<Api>;
  systemPrompt: string;
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high';
  maxRounds: number;
  messages?: AgentMessage[];
  /** Session-specific tools array (includes per-session ask_user). */
  tools: AgentTool<any>[];
}

export function createCebianAgent(options: CreateAgentOptions): Agent {
  const {
    model,
    systemPrompt,
    thinkingLevel,
    maxRounds,
    messages = [],
    tools: agentTools,
  } = options;

  const effectivePrompt = systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT;

  const agentOptions: AgentOptions = {
    initialState: {
      systemPrompt: effectivePrompt,
      model,
      thinkingLevel,
      tools: agentTools,
      messages,
    },

    // Convert AgentMessages to LLM messages (filter out any custom types)
    convertToLlm: (msgs: AgentMessage[]): Message[] => {
      return msgs.filter((m): m is Message =>
        'role' in m && ['user', 'assistant', 'toolResult'].includes((m as Message).role),
      );
    },

    // Context window management: sliding window based on maxRounds
    transformContext: async (msgs: AgentMessage[]): Promise<AgentMessage[]> => {
      const limit = maxRounds * 3; // ~3 messages per round (user + assistant + potential toolResult)
      if (msgs.length <= limit) return msgs;
      return msgs.slice(-limit);
    },

    // Dynamic API key resolution (handles OAuth token refresh)
    getApiKey: async (provider: string): Promise<string | undefined> => {
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
    },
  };

  return new Agent(agentOptions);
}

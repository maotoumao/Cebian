import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { createInteractiveBridge, INTERACTIVE_CANCELLED, type InteractiveBridge } from './interactive-bridge';
import { TOOL_ASK_USER } from '@/lib/types';

// ─── Request type ───

const AskUserParameters = Type.Object({
  question: Type.String({ description: 'The question to ask the user.' }),
  options: Type.Optional(
    Type.Array(
      Type.Object({
        label: Type.String({ description: 'Short label for the option button.' }),
        description: Type.Optional(
          Type.String({ description: 'Optional description shown alongside the option.' }),
        ),
      }),
      { description: 'Predefined options the user can choose from.' },
    ),
  ),
  allow_free_text: Type.Optional(
    Type.Boolean({
      description:
        'Whether the user can type a free-form answer. Defaults to true.',
    }),
  ),
});

export type AskUserRequest = Static<typeof AskUserParameters>;

// ─── Tool details ───

interface AskUserDetails {
  cancelled: boolean;
}

// ─── Shared tool metadata (reused by createSessionAskUserTool) ───

export const ASK_USER_META = {
  name: TOOL_ASK_USER,
  label: 'Ask User',
  description:
    'Ask the user a question, present choices, or request a decision. ' +
    'You MUST use this tool whenever your response requires user input to proceed — ' +
    'including clarifications, confirmations, and presenting options (e.g. A/B/C choices). ' +
    'NEVER write questions or options as plain text in your response; always use this tool instead. ' +
    'Provide clear options when possible. The user may also type a free-form answer.',
  parameters: AskUserParameters,
} as const;

// ─── Factory: creates a session-specific ask_user tool + bridge ───

export function createSessionAskUserTool(): {
  tool: AgentTool<typeof AskUserParameters, AskUserDetails>;
  bridge: InteractiveBridge<AskUserRequest, string>;
} {
  const bridge = createInteractiveBridge<AskUserRequest, string>();

  const tool: AgentTool<typeof AskUserParameters, AskUserDetails> = {
    ...ASK_USER_META,
    async execute(toolCallId, params, signal): Promise<AgentToolResult<AskUserDetails>> {
      const result = await bridge.request(toolCallId, params, signal);

      if (result === INTERACTIVE_CANCELLED) {
        return {
          content: [{ type: 'text', text: '用户跳过了此问题。' }],
          details: { cancelled: true },
        };
      }

      return {
        content: [{ type: 'text', text: result }],
        details: { cancelled: false },
      };
    },
  };

  return { tool, bridge };
}

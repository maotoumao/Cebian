import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { createInteractiveBridge, INTERACTIVE_CANCELLED } from './interactive-bridge';
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

// ─── Bridge instance (module-level singleton) ───

export const askUserBridge = createInteractiveBridge<AskUserRequest, string>();

// ─── Tool details ───

interface AskUserDetails {
  cancelled: boolean;
}

// ─── Tool definition ───

export const askUserTool: AgentTool<typeof AskUserParameters, AskUserDetails> = {
  name: TOOL_ASK_USER,
  label: 'Ask User',
  description:
    'Ask the user a clarifying question before proceeding. ' +
    'Provide clear options when possible. The user may also type a free-form answer. ' +
    'Use this when you need more information from the user to complete the task.',
  parameters: AskUserParameters,

  async execute(toolCallId, params, signal): Promise<AgentToolResult<AskUserDetails>> {
    const result = await askUserBridge.request(toolCallId, params, signal);

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

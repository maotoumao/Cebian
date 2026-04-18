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
    'Prioritize this tool over writing questions in plain text — ' +
    'it gives the user a structured prompt with clickable options. ' +
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
          // English by design: this text is LLM-facing tool result context, not
          // user-visible UI. The structured `details.cancelled` flag is the
          // canonical signal; the text is purely for the model's reasoning.
          content: [{ type: 'text', text: 'User skipped this question.' }],
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

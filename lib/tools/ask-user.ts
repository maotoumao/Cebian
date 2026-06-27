import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { createInteractiveBridge, INTERACTIVE_CANCELLED, type InteractiveBridge } from './interactive-bridge';
import { TOOL_ASK_USER } from '@/lib/tools/names';

// ─── Types ───

/** A single selectable option with optional description and recommended flag. */
export const AskUserOption = Type.Object({
  label: Type.String({ description: 'Display text for this option.' }),
  value: Type.String({ description: 'Machine-readable value returned when selected.' }),
  description: Type.Optional(
    Type.String({ description: 'Optional helper text shown alongside the option.' }),
  ),
  recommended: Type.Optional(
    Type.Boolean({
      description:
        'Whether this option is the recommended default. ' +
        'UI should show a "Recommended" badge.',
    }),
  ),
});

/** A single question/field within an ask_user request. */
const AskUserQuestion = Type.Object({
  // ── Identity ──
  id: Type.String({
    description:
      'Machine-readable answer key. Not shown to the user. ' +
      'Must be unique within this ask_user request.',
  }),

  // ── Field type ──
  type: Type.Optional(
    Type.Union([
      Type.Literal('text'),
      Type.Literal('textarea'),
      Type.Literal('single_select'),
      Type.Literal('multi_select'),
      Type.Literal('dropdown'),
    ], {
      description: 'Field type. Defaults to "text" when omitted.',
    }),
  ),

  // ── Display ──
  question: Type.String({
    description:
      'The question shown to the user. Plain text only; Markdown is not rendered. ' +
      'Use newline characters (\\n) for line breaks.',
  }),
  message: Type.Optional(
    Type.String({
      description: 'Optional supporting text shown below the question. Plain text only.',
    }),
  ),
  placeholder: Type.Optional(
    Type.String({ description: 'Placeholder text shown inside the input when empty.' }),
  ),

  // ── Options (for select types) ──
  options: Type.Optional(
    Type.Array(AskUserOption, {
      description: 'Choices for single_select, multi_select, and dropdown fields.',
    }),
  ),

  // ── Constraints ──
  required: Type.Optional(
    Type.Boolean({ description: 'Whether the field must be filled. Defaults to false.' }),
  ),
  allow_free_text: Type.Optional(
    Type.Boolean({
      description:
        'Whether the user can type a free-form answer. ' +
        'Defaults to true when no options are provided, false when options exist.',
    }),
  ),
  multiple: Type.Optional(
    Type.Boolean({
      description:
        '[Deprecated — use type: "multi_select" instead] ' +
        'Whether the user can select multiple options. Only valid with options. Defaults to false.',
    }),
  ),
  min_select: Type.Optional(
    Type.Number({
      description: 'Minimum number of selections. Only meaningful for multi_select.',
    }),
  ),
  max_select: Type.Optional(
    Type.Number({
      description: 'Maximum number of selections. Only meaningful for multi_select.',
    }),
  ),
});

// ─── Top-level parameters (new, multi-field schema) ───

const AskUserNewParams = Type.Object({
  title: Type.Optional(
    Type.String({
      description:
        'Form-level title shown at the top. ' +
        'Useful when asking multiple related questions (e.g. "User Registration"). ' +
        'When omitted with a single question, no title is shown and UI stays compact.',
    }),
  ),
  description: Type.Optional(
    Type.String({
      description:
        'Form-level explanatory text shown below the title. ' +
        'Useful for providing context before multiple questions.',
    }),
  ),
  submit_label: Type.Optional(
    Type.String({
      description: 'Submit button text. Defaults to "Submit" per locale.',
    }),
  ),
  questions: Type.Array(AskUserQuestion, {
    minItems: 1,
    description:
      'One or more questions to ask. ' +
      'A single question with no title uses compact mode; multiple questions or a title trigger form mode.',
  }),
});

// ─── Legacy parameters (single question, backward compatible) ───

const AskUserLegacyParams = Type.Object({
  question: Type.String({
    description:
      'The question to ask the user. Plain text only — Markdown is not rendered. ' +
      'Use newline characters (\\n) for line breaks.',
  }),
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
      description: 'Whether the user can type a free-form answer. Defaults to true.',
    }),
  ),
});

// ─── Request types ───

export type AskUserOption = Static<typeof AskUserOption>;
export type AskUserQuestion = Static<typeof AskUserQuestion>;

/** Legacy single-question request (backward compatible). */
export type AskUserLegacyRequest = Static<typeof AskUserLegacyParams>;

/** New multi-field request. */
export type AskUserNewRequest = Static<typeof AskUserNewParams>;

/** The normalized internal request type that the UI always receives. */
export interface AskUserRequest extends AskUserNewRequest {}

// ─── Response types ───

/** A single field's answer. */
export interface AskUserAnswer {
  /** Answer value. Type depends on field type:
   *  text/textarea/single_select/dropdown → string.
   *  multi_select → string[].
   *  Unfilled optional fields → null. */
  value: string | string[] | null;
  /** Whether the user explicitly skipped this question. Defaults to false. */
  skipped?: boolean;
}

export type AskUserResponse =
  | { answers: Record<string, AskUserAnswer> }
  | { cancelled: true };

// ─── Normalization: legacy → new ───

export function normalizeRequest(raw: Record<string, unknown>): AskUserRequest {
  // New format: has `questions` array
  if (Array.isArray(raw.questions) && raw.questions.length > 0) {
    return raw as unknown as AskUserRequest;
  }

  // Legacy format: single question
  const legacy = raw as unknown as AskUserLegacyRequest;
  const question: AskUserQuestion = {
    id: 'q0',
    question: legacy.question,
    type: (legacy.options && legacy.options.length > 0) ? 'single_select' : 'text',
    allow_free_text: legacy.allow_free_text,
  };

  if (legacy.options) {
    question.options = legacy.options.map(opt => {
      const labelStr = String(opt.label ?? '');
      return {
        label: labelStr,
        value: labelStr,
        description: 'description' in opt ? (opt as any).description : undefined,
      };
    });
  }

  return { questions: [question] };
}

// ─── Response normalization: new → legacy string ───

function normalizeResponse(response: AskUserResponse): string {
  if ('cancelled' in response) {
    return 'User skipped this question.';
  }
  const answers = response.answers;
  if (!answers) return '';

  // Build a readable summary for the LLM
  const parts: string[] = [];
  for (const [id, answer] of Object.entries(answers)) {
    if (answer.skipped) {
      parts.push(`${id}: skipped`);
    } else if (Array.isArray(answer.value)) {
      parts.push(`${id}: [${answer.value.join(', ')}]`);
    } else {
      parts.push(`${id}: ${answer.value ?? ''}`);
    }
  }
  return parts.length > 0 ? parts.join('\n') : '';
}

// ─── Tool details ───

interface AskUserDetails {
  cancelled: boolean;
}

const ASK_USER_META = {
  name: TOOL_ASK_USER,
  label: 'Ask User',
  description:
    'Ask the user questions, present a form, or request a decision. ' +
    'Always use the `questions` array. ' +
    'For a single simple question, pass one question object with id, question, and optional options/type. ' +
    'For collecting multiple related fields at once (e.g. configuration, preferences, ' +
    'data entry), pass multiple questions with an optional `title` — this presents ' +
    'a structured form so the user can fill all fields at once. ' +
    'Prioritize this tool over writing questions in plain text — ' +
    'it gives the user a structured prompt. Provide clear options when possible.',
  parameters: AskUserNewParams,
} as const;

// ─── Factory ───

export function createSessionAskUserTool(): {
  tool: AgentTool<any, AskUserDetails>;
  bridge: InteractiveBridge<AskUserRequest, AskUserResponse>;
} {
  const bridge = createInteractiveBridge<AskUserRequest, AskUserResponse>();

  const tool: AgentTool<any, AskUserDetails> = {
    ...ASK_USER_META,
    async execute(toolCallId, params, signal): Promise<AgentToolResult<AskUserDetails>> {
      // Normalize legacy params to the new internal format
      const normalized = normalizeRequest(params as Record<string, unknown>);
      const result = await bridge.request(toolCallId, normalized, signal);

      if (result === INTERACTIVE_CANCELLED) {
        return {
          content: [{ type: 'text', text: 'User skipped this question.' }],
          details: { cancelled: true },
        };
      }

      if ('cancelled' in result) {
        return {
          content: [{ type: 'text', text: 'User skipped this question.' }],
          details: { cancelled: true },
        };
      }

      const text = normalizeResponse(result);
      return {
        content: [{ type: 'text', text: text }],
        details: { cancelled: false },
      };
    },
  };

  return { tool, bridge };
}

export { ASK_USER_META };

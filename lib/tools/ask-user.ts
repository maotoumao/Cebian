import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { createInteractiveBridge, INTERACTIVE_CANCELLED, type InteractiveBridge } from './interactive-bridge';
import { TOOL_ASK_USER } from '@/lib/tools/names';

// ─── Request type ───
// 一次 ask_user 调用可携带多道问题（批量收集），每道问题可以是单选 / 多选 /
// 自由文本，或选项 + 自由文本并存。字段一律 snake_case，与项目其它工具一致。

const AskUserOption = Type.Object({
  label: Type.String({ description: 'Short label shown for the option.' }),
  description: Type.Optional(
    Type.String({
      description: 'Optional plain-text description shown alongside or as a tooltip.',
    }),
  ),
  recommended: Type.Optional(
    Type.Boolean({ description: 'Whether this option is the recommended default.' }),
  ),
});

const AskUserQuestion = Type.Object({
  id: Type.String({
    description:
      'Stable machine-readable answer key. Not shown to the user. ' +
      'Must be unique within this ask_user request.',
  }),
  question: Type.String({
    description:
      'The question shown to the user. Plain text only — Markdown is not rendered. ' +
      'Use newline characters (\\n) for line breaks.',
  }),
  message: Type.Optional(
    Type.String({
      description: 'Optional supporting text shown below the question. Plain text only.',
    }),
  ),
  options: Type.Optional(
    Type.Array(AskUserOption, {
      description: 'Predefined options the user can choose from.',
    }),
  ),
  multiple: Type.Optional(
    Type.Boolean({
      description: 'Whether the user can select multiple options. Defaults to false.',
    }),
  ),
  allow_free_text: Type.Optional(
    Type.Boolean({
      description: 'Whether the user can type a free-form answer. Defaults to true.',
    }),
  ),
});

const AskUserParameters = Type.Object({
  questions: Type.Array(AskUserQuestion, {
    minItems: 1,
    description:
      'One or more questions to ask in a single prompt. Use one item for a single question.',
  }),
});

export type AskUserRequest = Static<typeof AskUserParameters>;

// ─── Response type (UI → bridge → execute) ───
// 用户填完表单后回传的结构。content 直接 JSON 序列化这份 answers 给 LLM（裸 JSON，
// 用户输入作为 JSON 字符串值自动转义，防止伪造结构）；同一份对象也存进 details
// 供卡片已答态渲染。单选的 selected 也是数组；free_text 与 selected 可共存，
// 无自由文本时为空串 ''。

export interface AskUserAnswer {
  /** Selected option labels. Single-choice answers still use an array. */
  selected: string[];
  /** Free-form answer text, or '' when none was provided. */
  free_text: string;
  /** Whether this question was skipped (no answer provided). */
  skipped: boolean;
}

export interface AskUserResponse {
  answers: Record<string, AskUserAnswer>;
}

// ─── Tool details ───

interface AskUserDetails {
  cancelled: boolean;
  /** Structured answers for UI rendering of the answered card. Absent when cancelled. */
  answers?: Record<string, AskUserAnswer>;
}

// ─── Shared tool metadata (reused by createSessionAskUserTool) ───

const ASK_USER_META = {
  name: TOOL_ASK_USER,
  label: 'Ask User',
  description:
    'Ask the user one or more questions in a single structured prompt, then collect ' +
    'their answers. Prioritize this tool over writing questions in plain text — ' +
    'it gives the user a clickable form instead of free-form chat. Batch related ' +
    'questions into one call (each with a unique id) rather than asking one at a time. ' +
    'Each question may offer options (single- or multi-select via `multiple`) and/or ' +
    'a free-form text field (`allow_free_text`). The result is JSON: ' +
    '`{ answers: { <id>: { selected, free_text, skipped } } }`.',
  parameters: AskUserParameters,
  // interactive-bridge 每个工具只有一个 pending 槽位：同一轮里并发两个 ask_user
  // 后者会取消前者。声明 sequential 让 pi-agent-core 逐个执行，避免互相顶掉
  executionMode: 'sequential',
} as const;

// ─── Factory: creates a session-specific ask_user tool + bridge ───

export function createSessionAskUserTool(): {
  tool: AgentTool<typeof AskUserParameters, AskUserDetails>;
  bridge: InteractiveBridge<AskUserRequest, AskUserResponse>;
} {
  const bridge = createInteractiveBridge<AskUserRequest, AskUserResponse>();

  const tool: AgentTool<typeof AskUserParameters, AskUserDetails> = {
    ...ASK_USER_META,
    async execute(toolCallId, params, signal): Promise<AgentToolResult<AskUserDetails>> {
      // id 会作为返回给模型的 answers 对象的键，必须非空且互不重复，否则两题答案会相互覆盖。
      // 入参由模型生成，这里是 system boundary，重复/空 id 视为模型错误 → throw 让其重试。
      const seen = new Set<string>();
      for (const q of params.questions) {
        if (!q.id) {
          throw new Error('Each ask_user question must have a non-empty id.');
        }
        if (seen.has(q.id)) {
          throw new Error(
            `Duplicate ask_user question id: "${q.id}". Each question id must be unique within one ask_user call.`,
          );
        }
        seen.add(q.id);
      }

      const result = await bridge.request(toolCallId, params, signal);

      if (result === INTERACTIVE_CANCELLED) {
        return {
          // English by design: this text is LLM-facing tool result context, not
          // user-visible UI. The structured `details.cancelled` flag is the
          // canonical signal; the text is purely for the model's reasoning.
          content: [{ type: 'text', text: 'User dismissed the form without answering.' }],
          details: { cancelled: true },
        };
      }

      // 结果以裸 JSON 返回给模型：用户输入被 JSON.stringify 转义，无法伪造同级字段。
      return {
        content: [{ type: 'text', text: JSON.stringify({ answers: result.answers }) }],
        details: { cancelled: false, answers: result.answers },
      };
    },
  };

  return { tool, bridge };
}

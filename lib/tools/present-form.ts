import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { createInteractiveBridge, INTERACTIVE_CANCELLED, type InteractiveBridge } from './interactive-bridge';
import { TOOL_PRESENT_FORM } from '@/lib/tools/names';

// ─── Request type ───

const FieldType = Type.Union([
  Type.Literal('text'),
  Type.Literal('textarea'),
  Type.Literal('single_select'),
  Type.Literal('multi_select'),
  Type.Literal('dropdown'),
]);

const OptionDef = Type.Object({
  label: Type.String({ description: 'Display text for this option.' }),
  value: Type.String({ description: 'Machine-readable value returned when selected.' }),
  description: Type.Optional(Type.String({ description: 'Optional helper text shown alongside the option.' })),
});

const FormField = Type.Object({
  id: Type.String({
    description:
      'Machine-readable field identifier. Used as the key in the returned values object. ' +
      'Use short snake_case identifiers (e.g. "name", "preferred_language", "interests").',
  }),
  label: Type.String({ description: 'Human-readable label shown above the field.' }),
  type: FieldType,
  required: Type.Optional(Type.Boolean({ description: 'Whether the field must be filled. Defaults to false.' })),
  placeholder: Type.Optional(Type.String({ description: 'Placeholder text shown inside the input when empty.' })),
  options: Type.Optional(
    Type.Array(OptionDef, {
      description:
        'Choices for single_select, multi_select, and dropdown fields. Required for those types.',
    }),
  ),
  min_select: Type.Optional(
    Type.Number({ description: 'Minimum number of options the user must select. Only for multi_select.' }),
  ),
  max_select: Type.Optional(
    Type.Number({ description: 'Maximum number of options the user can select. Only for multi_select.' }),
  ),
});

const PresentFormParameters = Type.Object({
  title: Type.String({
    description:
      'Form title shown at the top. Should be a short, clear description of what the user needs to provide ' +
      '(e.g. "配置偏好设置", "填写订单信息", "选择要导出的数据").',
  }),
  description: Type.Optional(
    Type.String({
      description:
        'Optional explanatory text shown below the title. Use to provide context or instructions. ' +
        'Keep it concise — the form fields should carry most of the guidance.',
    }),
  ),
  fields: Type.Array(FormField, {
    description:
      'Ordered list of form fields. The user fills them in order from top to bottom. ' +
      'Each field has an id (key in the response), a label, and a type. ' +
      'Choose the right type per question: ' +
      'text for single-line (name, email, URL), textarea for multi-line (comments, bio), ' +
      'single_select for mutually exclusive options (yes/no, platform choice), ' +
      'multi_select for "select all that apply" (interests, features), ' +
      'dropdown for a long list of options (country, language) where the list would be too long as radio buttons.',
  }),
  submit_label: Type.Optional(
    Type.String({
      description: 'Submit button text. Defaults to "提交" in user-facing UI.',
    }),
  ),
});

export type PresentFormRequest = Static<typeof PresentFormParameters>;
export type PresentFormField = Static<typeof FormField>;

// ─── Response type ───

/** LLM 收到的结构化响应。values 的 key 对应 field.id，value 类型由 field 类型决定：
 *  - text / textarea / dropdown / single_select → string
 *  - multi_select → string[]
 *  - 用户未填的选填字段 → null */
export interface PresentFormResponse {
  values: Record<string, string | string[] | null>;
  cancelled?: boolean;
}

// ─── Tool details type ───

interface PresentFormDetails {
  cancelled: boolean;
}

// ─── Factory ───

export function createSessionPresentFormTool(): {
  tool: AgentTool<typeof PresentFormParameters, PresentFormDetails>;
  bridge: InteractiveBridge<PresentFormRequest, PresentFormResponse>;
} {
  const bridge = createInteractiveBridge<PresentFormRequest, PresentFormResponse>();

  const tool: AgentTool<typeof PresentFormParameters, PresentFormDetails> = {
    name: TOOL_PRESENT_FORM,
    label: 'Present Form',
    description:
      'Present a multi-field form to the user. Use this when you need to collect several pieces of ' +
      'information at once — the user fills all fields and submits once, rather than going back and forth ' +
      'through multiple ask_user turns. Suitable for: configuration panels, survey-style questions, ' +
      'data entry forms, preference settings, or any scenario with 2+ related inputs. ' +
      'Returns a structured { values: { field_id: answer } } object. ' +
      'Each field has a type: text (single line), textarea (multi-line), ' +
      'single_select (radio buttons), multi_select (checkboxes), dropdown (select menu).',
    parameters: PresentFormParameters,

    async execute(toolCallId, params, signal): Promise<AgentToolResult<PresentFormDetails>> {
      const result = await bridge.request(toolCallId, params, signal);

      if (result === INTERACTIVE_CANCELLED) {
        return {
          content: [{ type: 'text', text: 'User dismissed the form without submitting.' }],
          details: { cancelled: true },
        };
      }

      // 把结构化响应序列化为人类可读 + 机器可读的文本
      const summary = formatFormResult(params.fields, result.values);
      const json = JSON.stringify(result.values);

      return {
        content: [{
          type: 'text',
          text: `Form submitted. Values as JSON:\n\`\`\`json\n${json}\n\`\`\`\n\nSummary:\n${summary}`,
        }],
        details: { cancelled: false },
      };
    },
  };

  return { tool, bridge };
}

// ─── Helpers ───

function formatFormResult(
  fields: PresentFormField[],
  values: Record<string, string | string[] | null>,
): string {
  const lines: string[] = [];
  for (const field of fields) {
    const val = values[field.id];
    if (val == null || (Array.isArray(val) && val.length === 0)) {
      lines.push(`- ${field.label}: (not provided)`);
    } else if (Array.isArray(val)) {
      lines.push(`- ${field.label}: ${val.join(', ')}`);
    } else {
      lines.push(`- ${field.label}: ${val}`);
    }
  }
  return lines.join('\n');
}

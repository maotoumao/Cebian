import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_FS_EDIT_FILE } from '@/lib/tools/names';
import { vfs } from '@/lib/vfs';

const FsEditFileParameters = Type.Object({
  path: Type.String({
    description: 'Absolute path to the file to edit.',
  }),
  old_string: Type.String({
    description:
      'The exact text to find and replace. Must match exactly one location in the file ' +
      '(including whitespace and indentation). Include several lines of surrounding context to ensure uniqueness.',
  }),
  new_string: Type.String({
    description: 'The replacement text. Use an empty string to delete the matched text.',
  }),
});

export const fsEditFileTool: AgentTool<typeof FsEditFileParameters> = {
  name: TOOL_FS_EDIT_FILE,
  label: 'Edit File',
  description:
    'Edit an existing file in the virtual filesystem by replacing an exact string match. ' +
    'The old_string must appear exactly once in the file. ' +
    'Include enough surrounding context (3+ lines) to ensure uniqueness. ' +
    'To delete text, set new_string to an empty string.',
  parameters: FsEditFileParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{}>> {
    signal?.throwIfAborted();
    if (!(await vfs.exists(params.path))) {
      throw new Error(`File not found: ${params.path}`);
    }

    const raw = await vfs.readFile(params.path, 'utf8');
    const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);

    // 统计出现次数 —— old_string 必须唯一匹配
    let count = 0;
    let idx = 0;
    while ((idx = content.indexOf(params.old_string, idx)) !== -1) {
      count++;
      idx += params.old_string.length;
    }

    if (count === 0) {
      throw new Error(`old_string not found in ${params.path}. Ensure it matches exactly (including whitespace).`);
    }
    if (count > 1) {
      throw new Error(`old_string found ${count} times in ${params.path}. It must be unique — include more surrounding context.`);
    }

    const newContent = content.replace(params.old_string, () => params.new_string);
    await vfs.writeFile(params.path, newContent, 'utf8');

    return {
      content: [{ type: 'text', text: `Edited ${params.path}` }],
      details: {},
    };
  },
};

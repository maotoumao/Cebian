import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_FS_EDIT_FILE } from '@/lib/types';
import { vfs } from '@/lib/vfs';
import { invalidateSkillIndexIfNeeded } from './fs-helpers';

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

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    try {
      if (!(await vfs.exists(params.path))) {
        return {
          content: [{ type: 'text', text: `Error: file not found: ${params.path}` }],
          details: { status: 'error' },
        };
      }

      const raw = await vfs.readFile(params.path, 'utf8');
      const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);

      // Count occurrences
      let count = 0;
      let idx = 0;
      while ((idx = content.indexOf(params.old_string, idx)) !== -1) {
        count++;
        idx += params.old_string.length;
      }

      if (count === 0) {
        return {
          content: [{ type: 'text', text: 'Error: old_string not found in the file. Ensure it matches exactly (including whitespace).' }],
          details: { status: 'error' },
        };
      }
      if (count > 1) {
        return {
          content: [{ type: 'text', text: `Error: old_string found ${count} times. It must be unique — include more context.` }],
          details: { status: 'error' },
        };
      }

      const newContent = content.replace(params.old_string, () => params.new_string);
      await vfs.writeFile(params.path, newContent, 'utf8');
      invalidateSkillIndexIfNeeded(params.path);

      return {
        content: [{ type: 'text', text: `Edited ${params.path}` }],
        details: { status: 'done' },
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        details: { status: 'error' },
      };
    }
  },
};

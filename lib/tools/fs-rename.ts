import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_FS_RENAME } from '@/lib/types';
import { vfs } from '@/lib/vfs';

const FsRenameParameters = Type.Object({
  old_path: Type.String({
    description: 'Current absolute path of the file or directory to rename/move.',
  }),
  new_path: Type.String({
    description: 'New absolute path for the file or directory.',
  }),
});

export const fsRenameTool: AgentTool<typeof FsRenameParameters> = {
  name: TOOL_FS_RENAME,
  label: 'Rename / Move',
  description:
    'Rename or move a file or directory in the virtual filesystem.',
  parameters: FsRenameParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    try {
      if (!(await vfs.exists(params.old_path))) {
        return {
          content: [{ type: 'text', text: `Error: path not found: ${params.old_path}` }],
          details: { status: 'error' },
        };
      }
      // Ensure parent directory of new_path exists
      const parentDir = params.new_path.substring(0, params.new_path.lastIndexOf('/'));
      if (parentDir && parentDir !== '/') {
        await vfs.mkdir(parentDir, { recursive: true });
      }
      await vfs.rename(params.old_path, params.new_path);
      return {
        content: [{ type: 'text', text: `Renamed ${params.old_path} → ${params.new_path}` }],
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

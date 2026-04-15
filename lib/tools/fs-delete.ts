import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_FS_DELETE } from '@/lib/types';
import { vfs } from '@/lib/vfs';
import { invalidateSkillIndexIfNeeded } from './fs-helpers';

const FsDeleteParameters = Type.Object({
  path: Type.String({
    description: 'Absolute path of the file or directory to delete.',
  }),
  recursive: Type.Optional(Type.Boolean({
    description: 'If true, delete a directory and all its contents. Required for non-empty directories. Default: false.',
  })),
});

export const fsDeleteTool: AgentTool<typeof FsDeleteParameters> = {
  name: TOOL_FS_DELETE,
  label: 'Delete',
  description:
    'Delete a file or directory from the virtual filesystem. ' +
    'For non-empty directories, set recursive to true.',
  parameters: FsDeleteParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    try {
      if (!(await vfs.exists(params.path))) {
        return {
          content: [{ type: 'text', text: `Error: path not found: ${params.path}` }],
          details: { status: 'error' },
        };
      }
      await vfs.rm(params.path, { recursive: params.recursive ?? false, force: false });
      invalidateSkillIndexIfNeeded(params.path);
      return {
        content: [{ type: 'text', text: `Deleted ${params.path}` }],
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

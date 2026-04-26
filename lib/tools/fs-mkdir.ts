import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_FS_MKDIR } from '@/lib/types';
import { vfs } from '@/lib/vfs';

const FsMkdirParameters = Type.Object({
  path: Type.String({
    description: 'Absolute path of the directory to create (e.g. "/workspaces/abc/src/utils"). Intermediate directories are created automatically.',
  }),
});

export const fsMkdirTool: AgentTool<typeof FsMkdirParameters> = {
  name: TOOL_FS_MKDIR,
  label: 'Create Directory',
  description:
    'Create a directory in the virtual filesystem. ' +
    'Intermediate parent directories are created automatically. ' +
    'Succeeds silently if the directory already exists.',
  parameters: FsMkdirParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    try {
      await vfs.mkdir(params.path, { recursive: true });
      return {
        content: [{ type: 'text', text: `Created directory ${params.path}` }],
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

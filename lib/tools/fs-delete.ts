import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_FS_DELETE } from '@/lib/tools/names';
import { vfs } from '@/lib/vfs';

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

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{}>> {
    signal?.throwIfAborted();
    if (!(await vfs.exists(params.path))) {
      throw new Error(`Path not found: ${params.path}`);
    }
    await vfs.rm(params.path, { recursive: params.recursive ?? false, force: false });
    return {
      content: [{ type: 'text', text: `Deleted ${params.path}` }],
      details: {},
    };
  },
};

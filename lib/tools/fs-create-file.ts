import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_FS_CREATE_FILE } from '@/lib/tools/names';
import { vfs } from '@/lib/vfs';

const FsCreateFileParameters = Type.Object({
  path: Type.String({
    description: 'Absolute path for the new file (e.g. "/workspaces/abc/src/index.ts"). Parent directories are created automatically.',
  }),
  content: Type.String({
    description: 'The full content to write to the file.',
  }),
});

export const fsCreateFileTool: AgentTool<typeof FsCreateFileParameters> = {
  name: TOOL_FS_CREATE_FILE,
  label: 'Create File',
  description:
    'Create a new file in the virtual filesystem with the given content. ' +
    'Parent directories are created automatically. ' +
    'Fails if the file already exists — use fs_edit_file to modify existing files, ' +
    'or fs_delete then fs_create_file to overwrite.',
  parameters: FsCreateFileParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{}>> {
    signal?.throwIfAborted();
    if (await vfs.exists(params.path)) {
      throw new Error(`File already exists: ${params.path}. Use fs_edit_file to modify it, or fs_delete then fs_create_file to overwrite.`);
    }
    await vfs.writeFile(params.path, params.content, 'utf8');
    const byteLen = new TextEncoder().encode(params.content).length;
    return {
      content: [{ type: 'text', text: `Created ${params.path} (${byteLen} bytes)` }],
      details: {},
    };
  },
};

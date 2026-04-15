import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_FS_LIST } from '@/lib/types';
import { vfs } from '@/lib/vfs';
import { formatSize } from './fs-helpers';

const FsListParameters = Type.Object({
  path: Type.String({
    description: 'Absolute path of the directory to list (e.g. "/workspaces/abc").',
  }),
});

export const fsListTool: AgentTool<typeof FsListParameters> = {
  name: TOOL_FS_LIST,
  label: 'List Directory',
  description:
    'List the contents of a directory in the virtual filesystem. ' +
    'Shows entry names, types (file/directory), and sizes.',
  parameters: FsListParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    try {
      if (!(await vfs.exists(params.path))) {
        return {
          content: [{ type: 'text', text: `Error: path not found: ${params.path}` }],
          details: { status: 'error' },
        };
      }

      const info = await vfs.stat(params.path);
      if (!info.isDirectory()) {
        return {
          content: [{ type: 'text', text: `Error: ${params.path} is not a directory` }],
          details: { status: 'error' },
        };
      }

      const entries = await vfs.readdir(params.path);
      if (entries.length === 0) {
        return {
          content: [{ type: 'text', text: `${params.path} (empty directory)` }],
          details: { status: 'done' },
        };
      }

      const lines: string[] = [];
      for (const name of entries.sort()) {
        const fullPath = params.path === '/' ? `/${name}` : `${params.path}/${name}`;
        try {
          const info = await vfs.stat(fullPath);
          if (info.isDirectory()) {
            lines.push(`${name}/`);
          } else {
            lines.push(`${name}  (${formatSize(info.size)})`);
          }
        } catch {
          lines.push(`${name}  (inaccessible)`);
        }
      }

      return {
        content: [{ type: 'text', text: `${params.path}\n${lines.join('\n')}` }],
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

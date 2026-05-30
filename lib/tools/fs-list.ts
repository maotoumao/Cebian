import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
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

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{}>> {
    signal?.throwIfAborted();
    if (!(await vfs.exists(params.path))) {
      throw new Error(`Path not found: ${params.path}`);
    }

    const info = await vfs.stat(params.path);
    if (!info.isDirectory()) {
      throw new Error(`${params.path} is not a directory`);
    }

    const entries = await vfs.readdir(params.path);
    if (entries.length === 0) {
      // 空目录是正常结果，不是错误 —— agent 可以基于这个继续动作
      return {
        content: [{ type: 'text', text: `${params.path} (empty directory)` }],
        details: {},
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
      details: {},
    };
  },
};

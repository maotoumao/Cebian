import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_FS_READ_FILE } from '@/lib/types';
import { vfs } from '@/lib/vfs';
import { MAX_READ_SIZE, isBinaryContent, formatSize } from './fs-helpers';

const FsReadFileParameters = Type.Object({
  path: Type.String({
    description: 'Absolute path of the file to read.',
  }),
  start_line: Type.Optional(Type.Number({
    description: 'Start line number (1-based, inclusive). Omit to read from the beginning.',
  })),
  end_line: Type.Optional(Type.Number({
    description: 'End line number (1-based, inclusive). Omit to read to the end.',
  })),
});

export const fsReadFileTool: AgentTool<typeof FsReadFileParameters> = {
  name: TOOL_FS_READ_FILE,
  label: 'Read File',
  description:
    'Read the contents of a file from the virtual filesystem. ' +
    'Supports optional line range (1-based) to read a specific section. ' +
    'Large files (>100 KB) are automatically truncated — use start_line/end_line to read specific sections.',
  parameters: FsReadFileParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    try {
      if (!(await vfs.exists(params.path))) {
        return {
          content: [{ type: 'text', text: `Error: file not found: ${params.path}` }],
          details: { status: 'error' },
        };
      }

      const rawData = await vfs.readFile(params.path);
      const data = rawData instanceof Uint8Array ? rawData : new TextEncoder().encode(rawData as string);

      if (isBinaryContent(data)) {
        const stat = await vfs.stat(params.path);
        return {
          content: [{ type: 'text', text: `Binary file: ${params.path} (${formatSize(stat.size)})` }],
          details: { status: 'done' },
        };
      }

      const content = new TextDecoder().decode(data);
      const lines = content.split('\n');
      const totalLines = lines.length;

      const startLine = Math.max(1, params.start_line ?? 1);
      const endLine = Math.min(totalLines, params.end_line ?? totalLines);

      if (startLine > totalLines) {
        return {
          content: [{ type: 'text', text: `Error: start_line ${startLine} exceeds total lines (${totalLines})` }],
          details: { status: 'error' },
        };
      }

      const slice = lines.slice(startLine - 1, endLine);
      let text = slice.join('\n');

      if (text.length > MAX_READ_SIZE) {
        text = text.slice(0, MAX_READ_SIZE) +
          `\n\n--- Truncated (>${formatSize(MAX_READ_SIZE)}). Use start_line/end_line to read specific sections. ---`;
      }

      const rangeInfo = (params.start_line || params.end_line)
        ? `[Lines ${startLine}-${Math.min(endLine, totalLines)} of ${totalLines}]\n`
        : `[${totalLines} lines]\n`;

      return {
        content: [{ type: 'text', text: rangeInfo + text }],
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

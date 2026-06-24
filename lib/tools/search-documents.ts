import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_SEARCH_DOCUMENTS } from '@/lib/tools/names';
import { vfs, type VfsSearchResult } from '@/lib/persistence/vfs';

const SearchDocumentsParameters = Type.Object({
  keyword: Type.String({
    description: 'Keyword to search for in file and directory names (case-insensitive).',
  }),
  maxResults: Type.Optional(
    Type.Integer({
      description: 'Maximum number of results to return (default 50, max 200).',
      minimum: 1,
      maximum: 200,
      default: 50,
    }),
  ),
});

function formatSearchSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const searchDocumentsTool: AgentTool<typeof SearchDocumentsParameters> = {
  name: TOOL_SEARCH_DOCUMENTS,
  label: 'Search Documents',
  description: 'Search all documents and files in the virtual filesystem by name. Returns matching files and directories with their full absolute paths. Useful for locating files across all user directories without knowing the exact path.',
  parameters: SearchDocumentsParameters,

  async execute(_toolCallId, params, _signal): Promise<AgentToolResult<{}>> {
    const maxResults = params.maxResults ?? 50;
    const results: VfsSearchResult[] = await vfs.searchAll(
      params.keyword,
      '/',
      maxResults,
    );

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: `No files or directories found matching "${params.keyword}".` }],
        details: {},
      };
    }

    const lines = results.map((r, i) => {
      const kind = r.isDir ? '[DIR]' : '[FILE]';
      const size = r.isDir ? '' : `  ${formatSearchSize(r.size)}`;
      return `${i + 1}. ${kind} ${r.absPath}${size}`;
    });

    return {
      content: [{
        type: 'text',
        text: `Found ${results.length} result(s) for "${params.keyword}":\n\n${lines.join('\n')}`,
      }],
      details: {},
    };
  },
};

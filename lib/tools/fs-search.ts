import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_FS_SEARCH } from '@/lib/types';
import { vfs } from '@/lib/vfs';
import { walkDir, globMatch, isBinaryContent, MAX_SEARCH_RESULTS } from './fs-helpers';

const FsSearchParameters = Type.Object({
  pattern: Type.String({
    description:
      'Search pattern. For mode "name": a glob pattern matched against file paths (e.g. "**/*.ts", "src/**/*.json"). ' +
      'For mode "content": a regular expression matched against file contents (e.g. "TODO|FIXME", "function\\s+main").',
  }),
  path: Type.Optional(Type.String({
    description: 'Directory to search in. Defaults to "/" (entire filesystem). Use to narrow the search scope.',
  })),
  mode: Type.Union([Type.Literal('name'), Type.Literal('content')], {
    description: '"name" to search file paths by glob pattern, "content" to search file contents by regex.',
  }),
  case_sensitive: Type.Optional(Type.Boolean({
    description: 'Whether content search is case-sensitive. Default: false. Only applies to mode "content".',
  })),
});

export const fsSearchTool: AgentTool<typeof FsSearchParameters> = {
  name: TOOL_FS_SEARCH,
  label: 'Search Files',
  description:
    'Search the virtual filesystem by file name (glob) or file content (regex). ' +
    'Mode "name": matches file paths against a glob pattern (e.g. "**/*.ts"). ' +
    'Mode "content": searches file contents with a regular expression. ' +
    `Returns up to ${MAX_SEARCH_RESULTS} results.`,
  parameters: FsSearchParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    const searchRoot = params.path ?? '/';

    try {
      if (!(await vfs.exists(searchRoot))) {
        return {
          content: [{ type: 'text', text: `Error: directory not found: ${searchRoot}` }],
          details: { status: 'error' },
        };
      }

      const allFiles = await walkDir(searchRoot, signal);

      if (params.mode === 'name') {
        const matches = allFiles
          .filter(f => globMatch(params.pattern, f))
          .slice(0, MAX_SEARCH_RESULTS);

        if (matches.length === 0) {
          return {
            content: [{ type: 'text', text: `No files matching "${params.pattern}" in ${searchRoot}` }],
            details: { status: 'done' },
          };
        }

        const suffix = matches.length === MAX_SEARCH_RESULTS ? `\n(truncated at ${MAX_SEARCH_RESULTS} results)` : '';
        return {
          content: [{ type: 'text', text: matches.join('\n') + suffix }],
          details: { status: 'done' },
        };
      }

      // mode === 'content'
      const flags = params.case_sensitive ? 'g' : 'gi';
      let regex: RegExp;
      try {
        regex = new RegExp(params.pattern, flags);
      } catch (e) {
        return {
          content: [{ type: 'text', text: `Error: invalid regex: ${(e as Error).message}` }],
          details: { status: 'error' },
        };
      }

      const results: string[] = [];
      for (const filePath of allFiles) {
        if (results.length >= MAX_SEARCH_RESULTS) break;
        signal?.throwIfAborted();
        try {
          const raw = await vfs.readFile(filePath);
          const data = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw as string);
          if (isBinaryContent(data)) continue;
          const content = new TextDecoder().decode(data);
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= MAX_SEARCH_RESULTS) break;
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              results.push(`${filePath}:${i + 1}: ${lines[i].trim()}`);
            }
          }
        } catch {
          // skip unreadable files
        }
      }

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: `No matches for /${params.pattern}/ in ${searchRoot}` }],
          details: { status: 'done' },
        };
      }

      const suffix = results.length === MAX_SEARCH_RESULTS ? `\n(truncated at ${MAX_SEARCH_RESULTS} results)` : '';
      return {
        content: [{ type: 'text', text: results.join('\n') + suffix }],
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

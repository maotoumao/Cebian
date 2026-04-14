import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_EXECUTE_JS } from '@/lib/types';
import { getActiveTabId } from './chrome-api';

const ExecuteJsParameters = Type.Object({
  code: Type.String({
    description:
      'JavaScript code to execute in the active tab. ' +
      'The code is inserted as the body of `async () => { YOUR_CODE }` — use `return` directly to produce a result ' +
      '(e.g. `return document.title`). You can use `await` directly. ' +
      'NEVER wrap code in an IIFE like `(()=>{ return x })()` — the inner return does not propagate and the result will be null. ' +
      'The return value will be JSON-serialized.',
  }),
  frameId: Type.Optional(
    Type.Number({
      description:
        'Frame ID to execute in. Omit or 0 for the top frame. ' +
        'Use tab({ action: "list_frames" }) to discover frame IDs.',
    }),
  ),
});

export const executeJsTool: AgentTool<typeof ExecuteJsParameters> = {
  name: TOOL_EXECUTE_JS,
  label: 'Execute JavaScript',
  description:
    'Execute JavaScript code in the active browser tab and return the result. ' +
    'The code runs as an async function body — use `return` to produce a result (e.g. `return document.title`). ' +
    'Use for DOM operations, data extraction, page modifications, ' +
    'calling page APIs, or reading localStorage/sessionStorage. ' +
    'The code runs in the page context with full access to the DOM and page globals. ' +
    'The return value is JSON-serialized.',
  parameters: ExecuteJsParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    const tabId = await getActiveTabId();

    const target = params.frameId != null
      ? { tabId, frameIds: [params.frameId] }
      : { tabId };

    const results = await chrome.scripting.executeScript({
      target,
      func: (code: string) => {
        return new Function(`return (async () => { ${code} })()`)();
      },
      args: [params.code],
      ...({ world: 'MAIN' } as any),
    });

    const result = results?.[0];
    const output = result?.result;

    let text: string;
    try {
      text = output === undefined ? '(no return value)' : JSON.stringify(output, null, 2);
    } catch {
      text = `(result could not be serialized — got ${typeof output})`;
    }

    return {
      content: [{ type: 'text', text }],
      details: { status: 'done' },
    };
  },
};

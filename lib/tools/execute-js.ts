import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_EXECUTE_JS } from '@/lib/types';
import { executeViaDebugger } from '@/lib/tab-helpers';

/** Sentinel value returned by the injected func when CSP blocks new Function(). */
const CSP_BLOCKED = '__cebian_csp_blocked__';

const ExecuteJsParameters = Type.Object({
  code: Type.String({
    description:
      'JavaScript code to execute in the target tab. ' +
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
  tabId: Type.Number({
    description:
      'Required. Tab ID to execute in. Read it from the `tabId:` line under `[Active Tab]` (or the windows list) in the context block. ' +
      'Never omit — the active tab may have changed since the last context snapshot.',
  }),
});

export const executeJsTool: AgentTool<typeof ExecuteJsParameters> = {
  name: TOOL_EXECUTE_JS,
  label: 'Execute JavaScript',
  description:
    'Execute JavaScript code in a browser tab and return the result. ' +
    'The code runs as an async function body — use `return` to produce a result (e.g. `return document.title`). ' +
    'Use for DOM operations, data extraction, page modifications, ' +
    'calling page APIs, or reading localStorage/sessionStorage. ' +
    'The code runs in the page context with full access to the DOM and page globals. ' +
    'The return value is JSON-serialized.',
  parameters: ExecuteJsParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    const tabId = params.tabId;

    const target = params.frameId != null
      ? { tabId, frameIds: [params.frameId] }
      : { tabId };

    // Try executing via chrome.scripting.executeScript (MAIN world).
    // If the page has a strict CSP that blocks eval/new Function, the injected
    // func catches the error and returns a sentinel so we can fall back to CDP.
    const results = await chrome.scripting.executeScript({
      target,
      func: async (code: string, cspSentinel: string) => {
        try {
          return await new Function(`return (async () => { ${code} })()`)();
        } catch (e: any) {
          if (e.message && /unsafe-eval|Content Security Policy/i.test(e.message)) {
            return cspSentinel;
          }
          throw e;
        }
      },
      args: [params.code, CSP_BLOCKED],
      ...({ world: 'MAIN' } as any),
    });

    const result = results?.[0];
    let text: string;

    if ((result as any)?.error) {
      const err = (result as any).error;
      text = `Error: ${err.message ?? JSON.stringify(err)}`;
    } else if (result?.result === CSP_BLOCKED) {
      // CSP blocked eval — fall back to CDP Runtime.evaluate
      text = await executeViaDebugger(tabId, params.code);
    } else {
      const output = result?.result;
      try {
        text = output === undefined ? '(no return value)' : JSON.stringify(output, null, 2);
      } catch {
        text = `(result could not be serialized — got ${typeof output})`;
      }
    }

    return {
      content: [{ type: 'text', text }],
      details: { status: 'done' },
    };
  },
};

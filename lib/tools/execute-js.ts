import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_EXECUTE_JS } from '@/lib/types';
import { executeViaDebugger } from '@/lib/tab-helpers';
import { vfs } from '@/lib/vfs';

/** Sentinel value returned by the injected func when CSP blocks new Function(). */
const CSP_BLOCKED = '__cebian_csp_blocked__';

const ExecuteJsParameters = Type.Object({
  code: Type.String({
    description:
      'JavaScript code to execute in the target tab. ' +
      'The code is inserted as the body of `async () => { YOUR_CODE }` — use `return` directly to produce a result ' +
      '(e.g. `return document.title`). You can use `await` directly. ' +
      'NEVER wrap code in an IIFE like `(()=>{ return x })()` — the outer async function has no top-level `return`, so the result comes back as `(no return value)`. Use a bare top-level `return x` instead. ' +
      'The return value is JSON-serialized and returned to you in full — there is no hidden size limit, so do not pre-chunk results or probe for a maximum size. ' +
      'For results small enough to reason about inline, return them directly; for results large enough to bloat the conversation (full-page extracts, generated reports, structured data dumps), set `outputPath` to land them in VFS instead.',
  }),
  outputPath: Type.Optional(
    Type.String({
      description:
        'If set, the return value is written to this absolute VFS path (e.g. "/workspaces/abc/page.md") and only a short summary is returned to you. ' +
        'Use this whenever the natural result is large enough that returning it inline would bloat the conversation — the bytes go straight to disk and never enter your context. ' +
        'Strings are written verbatim; other values are written as pretty-printed JSON (2-space indent). ' +
        'Parent directories are created automatically. Existing files are overwritten. ' +
        'The script must `return` a non-empty value — returning null/undefined is an error.',
    }),
  ),
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
    'The return value is JSON-serialized and returned in full — do not pre-chunk or probe for a size limit.',
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

    // Compute a single display-formatted `text` for both execution paths and
    // both output sinks (inline return / outputPath write):
    //   - MAIN-world success: `result.result` is the raw return value. We
    //     format with "string verbatim, else JSON.stringify(_, null, 2)" —
    //     the same rule executeViaDebugger uses for the CSP fallback path.
    //     Aligning these means `return "foo"` produces `foo` (not `"foo"`)
    //     regardless of which execution path was taken.
    //   - CSP fallback: the helper already returns a display-formatted string;
    //     we use it as-is.
    // `canWrite` is true iff `text` represents a real payload — undefined /
    // null returns, serialization failures, and the helper's sentinel
    // strings all flip it false so the outputPath branch refuses to write.
    let text: string;
    let canWrite: boolean;
    if (result?.result === CSP_BLOCKED) {
      text = await executeViaDebugger(tabId, params.code);
      canWrite = text !== '(no return value)' && !text.startsWith('Error: ');
    } else {
      const rawValue = result?.result;
      // null and undefined are treated identically: neither is a usable
      // payload, so both render as the same sentinel inline and are both
      // rejected by outputPath. Pre-refactor this only short-circuited on
      // undefined; `return null` used to leak through as the literal string
      // "null", which the model could mistake for the error info actually
      // being null instead of "the script returned nothing meaningful".
      if (rawValue === undefined || rawValue === null) {
        text = '(no return value)';
        canWrite = false;
      } else {
        canWrite = true;
        try {
          text = typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue, null, 2);
        } catch {
          text = `(result could not be serialized — got ${typeof rawValue})`;
          canWrite = false;
        }
      }
    }

    // ── outputPath branch ──
    // Bytes land directly in VFS; the agent only sees path + size + preview.
    if (params.outputPath) {
      if (!canWrite) {
        return {
          content: [{ type: 'text', text: `Error: nothing written to ${params.outputPath} — script produced no usable return value: ${text}. Use 'return <value>' with a serializable, non-empty payload.` }],
          details: { status: 'error' },
        };
      }
      try {
        await vfs.writeFile(params.outputPath, text, 'utf8');
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error writing ${params.outputPath}: ${(err as Error).message}` }],
          details: { status: 'error' },
        };
      }

      const byteLen = new TextEncoder().encode(text).length;
      const preview = text.length > 1024
        ? text.slice(0, 1024) + '\n…(preview truncated; full content is on disk)'
        : text;
      return {
        content: [{ type: 'text', text: `Wrote ${params.outputPath} (${byteLen} bytes)\nPreview:\n---\n${preview}\n---` }],
        details: { status: 'done' },
      };
    }

    // ── Inline-return branch ──
    return {
      content: [{ type: 'text', text }],
      details: { status: 'done' },
    };
  },
};

import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_FS_SAVE_URL } from '@/lib/types';
import { vfs } from '@/lib/vfs';
import { formatSize, invalidateSkillIndexIfNeeded } from './fs-helpers';

/** RequestInit subset we accept from the agent. Only fields that make sense
 *  for a from-the-LLM call are exposed. Notably, `body` is restricted to
 *  string — LLMs don't have a way to construct ArrayBuffer / FormData, and
 *  serialising those through tool args would defeat the token-saving point
 *  of this tool. JSON bodies go through `JSON.stringify` in the agent. */
const FsSaveUrlInit = Type.Object({
  method: Type.Optional(Type.Union([
    Type.Literal('GET'), Type.Literal('POST'), Type.Literal('PUT'),
    Type.Literal('PATCH'), Type.Literal('DELETE'), Type.Literal('HEAD'),
  ], { description: 'HTTP method. Defaults to GET.' })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), {
    description: 'HTTP request headers as a flat string-to-string object.',
  })),
  body: Type.Optional(Type.String({
    description: 'Request body. Only string bodies are supported — JSON-encode it yourself.',
  })),
  redirect: Type.Optional(Type.Union([
    Type.Literal('follow'), Type.Literal('error'), Type.Literal('manual'),
  ], { description: 'Redirect handling, mirrors fetch RequestInit.redirect. Defaults to "follow".' })),
  referrer: Type.Optional(Type.String({
    description:
      'Referrer URL for the request. Use "about:client" for the default ' +
      'or "no-referrer" to omit. Mirrors fetch RequestInit.referrer.',
  })),
  referrerPolicy: Type.Optional(Type.Union([
    Type.Literal(''), Type.Literal('no-referrer'), Type.Literal('no-referrer-when-downgrade'),
    Type.Literal('origin'), Type.Literal('origin-when-cross-origin'),
    Type.Literal('same-origin'), Type.Literal('strict-origin'),
    Type.Literal('strict-origin-when-cross-origin'), Type.Literal('unsafe-url'),
  ], { description: 'Referrer policy, mirrors fetch RequestInit.referrerPolicy.' })),
  credentials: Type.Optional(Type.Union([
    Type.Literal('omit'), Type.Literal('include'),
  ], { description: 'Cookie / auth credentials policy.' })),
  mode: Type.Optional(Type.Union([
    Type.Literal('cors'), Type.Literal('no-cors'),
  ], { description: 'Request mode, mirrors fetch RequestInit.mode.' })),
}, { description: 'Optional fetch init — subset of RequestInit.' });

/** Knobs that control how the response is saved into VFS. Kept under a
 *  separate `save` sub-object so the top-level signature stays focused on
 *  the fetch-equivalent shape. */
const FsSaveUrlSave = Type.Object({
  overwrite: Type.Optional(Type.Boolean({
    description: 'If false and `dest` already exists, the call fails. Defaults to true.',
  })),
  maxBytes: Type.Optional(Type.Number({
    description:
      '[NOT YET IMPLEMENTED] Abort and reject if the response body exceeds this many bytes. ' +
      'Defaults to 50 MB. Capped at a hard ceiling of 1 GB regardless of value.',
  })),
  sample: Type.Optional(Type.Boolean({
    description:
      '[NOT YET IMPLEMENTED] Include the first 1 KB of the saved content as `textSample` in the return ' +
      'value, but only for textual MIME types (text/*, application/json, etc.). ' +
      'Defaults to true. Binary MIME types never sample.',
  })),
}, { description: 'Optional save-behavior knobs.' });

const FsSaveUrlParameters = Type.Object({
  url: Type.String({
    description: 'The URL to fetch. Must be http(s).',
  }),
  dest: Type.String({
    description:
      'VFS path to save to. Currently must be a full file path (e.g. ' +
      '"/tmp/cat.jpg"). Directory dest with trailing "/" for automatic ' +
      'filename derivation is not yet implemented.',
  }),
  init: Type.Optional(FsSaveUrlInit),
  save: Type.Optional(FsSaveUrlSave),
});

export const fsSaveUrlTool: AgentTool<typeof FsSaveUrlParameters> = {
  name: TOOL_FS_SAVE_URL,
  label: 'Save URL',
  description:
    'Fetch a URL and save the response body to a VFS file. ' +
    'Use this to put remote resources (images, videos, PDFs, JSON, etc.) into VFS without ' +
    'round-tripping bytes through the conversation — never base64-encode binary content ' +
    'and pass it to fs_create_file. Parameters mirror fetch(url, init).',
  parameters: FsSaveUrlParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    try {
      // ── Input validation ──
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(params.url);
      } catch {
        return errorResult(`Invalid URL: ${params.url}`);
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return errorResult(`Unsupported URL scheme "${parsedUrl.protocol}". Only http(s) is allowed.`);
      }
      if (params.dest.endsWith('/')) {
        // Directory dest (filename derivation) lands in T3 — fail loud for
        // now so an LLM doesn't silently get a file written to the wrong
        // path when it expects filename derivation behavior.
        return errorResult('Directory dest (trailing "/") is not yet supported. Pass a full file path.');
      }

      const overwrite = params.save?.overwrite ?? true;
      // TODO(T3): once directory `dest` is supported, move the overwrite
      // existence check to AFTER filename derivation — checking the raw
      // `dest` is meaningless when `dest` is a directory (vfs.exists on a
      // dir is always true and means something different from "file
      // already exists at the final path").
      if (!overwrite && (await vfs.exists(params.dest))) {
        return errorResult(`File already exists at ${params.dest}; pass save.overwrite=true to replace it.`);
      }

      // ── Fetch ──
      // Bridge the agent's abort signal into our request so a user-issued
      // cancel reliably aborts an in-flight download. Forward `signal.reason`
      // so the downstream AbortError keeps the original cancellation cause.
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      let response: Response;
      try {
        response = await fetch(parsedUrl.href, buildRequestInit(params.init, controller.signal));
      } catch (err) {
        // Let AbortError bubble up to pi-agent-core's cancellation contract
        // (every other fs-* tool does the same). Other errors are network
        // failures we surface as a clean tool error.
        if ((err as Error).name === 'AbortError' || signal?.aborted) throw err;
        return errorResult(`Network error: ${(err as Error).message}`);
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      signal?.throwIfAborted();

      // `manual` redirect mode returns an opaque-redirect response (status 0,
      // empty body, no headers exposed). Saving that to VFS would write a
      // zero-byte file with no useful information — reject loud and steer
      // the agent toward `redirect: 'follow'` if it actually wants content.
      if (response.type === 'opaqueredirect') {
        return errorResult(
          'Got opaque-redirect response (init.redirect="manual") — nothing to save. ' +
          'Use init.redirect="follow" to fetch the redirect target.',
        );
      }
      if (!response.ok) {
        return errorResult(`HTTP ${response.status} ${response.statusText}`.trim(), response.status);
      }

      // ── Read body ──
      // T4 will replace this with streaming + size-cap; T2 buffers everything
      // for simplicity.
      const buf = await response.arrayBuffer();
      signal?.throwIfAborted();
      const bytes = buf.byteLength;
      const mime = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();

      // ── Write ──
      // `vfs.writeFile` accepts Uint8Array directly and auto-creates parent
      // dirs. Mirror the other fs-* tools by invalidating the skill index
      // if the write landed under the skills directory.
      await vfs.writeFile(params.dest, new Uint8Array(buf));
      invalidateSkillIndexIfNeeded(params.dest);

      return {
        content: [{
          type: 'text',
          text: `Saved ${params.dest} (${formatSize(bytes)}, ${mime}) from ${parsedUrl.href}`,
        }],
        details: { status: 'done' },
      };
    } catch (err) {
      // Same abort-pass-through as the inner catch.
      if ((err as Error).name === 'AbortError' || signal?.aborted) throw err;
      return errorResult((err as Error).message);
    }
  },
};

/** Build a RequestInit from the agent-supplied subset. Filters to only the
 *  fields we accept so we never accidentally forward unsanitized properties
 *  to fetch. */
function buildRequestInit(
  init: Static<typeof FsSaveUrlInit> | undefined,
  signal: AbortSignal,
): RequestInit {
  const out: RequestInit = { signal };
  if (!init) return out;
  if (init.method) out.method = init.method;
  if (init.headers) out.headers = init.headers;
  if (init.body !== undefined) out.body = init.body;
  if (init.redirect) out.redirect = init.redirect;
  if (init.referrer !== undefined) out.referrer = init.referrer;
  if (init.referrerPolicy !== undefined) out.referrerPolicy = init.referrerPolicy as ReferrerPolicy;
  if (init.credentials) out.credentials = init.credentials;
  if (init.mode) out.mode = init.mode;
  return out;
}

function errorResult(message: string, status?: number): AgentToolResult<{ status: string }> {
  const text = status !== undefined ? `Error: ${message} (status ${status})` : `Error: ${message}`;
  return {
    content: [{ type: 'text', text }],
    details: { status: 'error' },
  };
}

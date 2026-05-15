import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_FS_SAVE_URL } from '@/lib/types';
import { vfs } from '@/lib/vfs';
import { extensionForMime } from '@/lib/mime';
import { formatSize, invalidateSkillIndexIfNeeded } from './fs-helpers';

/** Default ceiling on response body bytes if the caller doesn't override
 *  via `save.maxBytes`. Comfortably fits typical screenshots, short clips,
 *  and JSON payloads while keeping a single tool call from spending hundreds
 *  of MB of browser memory. */
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
/** Hard upper bound regardless of caller-supplied `save.maxBytes`. Keeps
 *  an over-eager agent from instructing the tool to buffer multi-GB
 *  responses that would crash the service worker. */
const HARD_MAX_BYTES = 1024 * 1024 * 1024;

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
      'Abort and reject if the response body exceeds this many bytes. ' +
      'Defaults to 50 MB. Capped at a hard ceiling of 1 GB regardless of value. ' +
      'The check uses Content-Length as a pre-flight when present, and a running ' +
      'tally during streaming so oversized responses abort early without buffering.',
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
      'VFS path to save to. Pass a full file path (e.g. "/tmp/cat.jpg") to use ' +
      'it verbatim, OR a directory path ending with "/" (e.g. "/tmp/") to let ' +
      'the tool derive the filename from the response Content-Disposition ' +
      'header, the URL\'s last segment, or the MIME type — in that order.',
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

      const overwrite = params.save?.overwrite ?? true;
      // For a plain file dest (no trailing slash) we can short-circuit the
      // overwrite check before doing any network I/O. Directory dest needs
      // the response headers to derive a filename, so its overwrite check
      // is performed AFTER the fetch (see below).
      const destIsDirectory = params.dest.endsWith('/');
      if (!destIsDirectory && !overwrite && (await vfs.exists(params.dest))) {
        return errorResult(`File already exists at ${params.dest}; pass save.overwrite=true to replace it.`);
      }

      // ── Network I/O ──
      // Bridge the agent's abort signal into our request so a user-issued
      // cancel reliably aborts BOTH the fetch handshake AND the streaming
      // body read. The listener stays registered until the very end of the
      // network/write section so a cancellation mid-stream actually tears
      // down the in-flight fetch at the network layer — not just on the
      // next loop iteration's throwIfAborted check.
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        let response: Response;
        try {
          response = await fetch(parsedUrl.href, buildRequestInit(params.init, controller.signal));
        } catch (err) {
          // Let AbortError bubble up to pi-agent-core's cancellation contract
          // (every other fs-* tool does the same). Other errors are network
          // failures we surface as a clean tool error.
          if ((err as Error).name === 'AbortError' || signal?.aborted) throw err;
          return errorResult(`Network error: ${(err as Error).message}`);
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

        // ── Read body (streaming, with size cap) ──
        // Two-layer guard: a pre-flight check on Content-Length (when the
        // server provides it) lets us reject obviously-oversized responses
        // before reading a single byte, and a running tally during the read
        // loop catches servers that lie about Content-Length or omit it.
        const maxBytes = Math.min(params.save?.maxBytes ?? DEFAULT_MAX_BYTES, HARD_MAX_BYTES);

        const declaredLength = parseInt(response.headers.get('content-length') ?? '', 10);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          return errorResult(
            `Response too large: Content-Length declares ${formatSize(declaredLength)} ` +
            `> maxBytes ${formatSize(maxBytes)}. Pass save.maxBytes to raise the limit ` +
            `(hard cap ${formatSize(HARD_MAX_BYTES)}).`,
          );
        }

        const chunks: Uint8Array[] = [];
        let total = 0;
        const reader = response.body?.getReader();
        if (reader) {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              total += value.byteLength;
              if (total > maxBytes) {
                // Tear down the fetch immediately so we don't burn bandwidth
                // pulling the rest of an oversized body we're going to throw
                // away.
                controller.abort();
                return errorResult(
                  `Response exceeded maxBytes (${formatSize(maxBytes)}) at ${formatSize(total)}. ` +
                  `Pass save.maxBytes to raise the limit (hard cap ${formatSize(HARD_MAX_BYTES)}).`,
                );
              }
              chunks.push(value);
            }
          } catch (err) {
            if ((err as Error).name === 'AbortError' || signal?.aborted) throw err;
            return errorResult(`Network error during streaming: ${(err as Error).message}`);
          } finally {
            reader.releaseLock();
          }
        }
        signal?.throwIfAborted();

        // Concatenate the streamed chunks into one contiguous buffer for VFS.
        const buf = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          buf.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const mime = (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();

        // ── Resolve final dest path ──
        // For directory dest we now have the headers needed to derive a
        // filename. The overwrite check moves here so it runs against the
        // actual file path we're about to write to.
        let finalDest = params.dest;
        if (destIsDirectory) {
          const filename = deriveFilename(parsedUrl, response.headers.get('content-disposition'), mime);
          finalDest = params.dest + filename;
          if (!overwrite && (await vfs.exists(finalDest))) {
            return errorResult(`File already exists at ${finalDest}; pass save.overwrite=true to replace it.`);
          }
        }

        // ── Write ──
        // `vfs.writeFile` accepts Uint8Array directly and auto-creates parent
        // dirs. Mirror the other fs-* tools by invalidating the skill index
        // if the write landed under the skills directory.
        await vfs.writeFile(finalDest, buf);
        invalidateSkillIndexIfNeeded(finalDest);

        return {
          content: [{
            type: 'text',
            text: `Saved ${finalDest} (${formatSize(total)}, ${mime}) from ${parsedUrl.href}`,
          }],
          details: { status: 'done' },
        };
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    } catch (err) {
      // Same abort-pass-through as the inner catches.
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

/** Derive a filename for a directory-style `dest`. Tries in order:
 *  1. RFC 6266 / RFC 5987 `Content-Disposition` `filename*=` then `filename=`
 *  2. The URL pathname's last segment, but only if it has a `.` (so we
 *     don't end up with `download` from a path like `/api/download`)
 *  3. `Untitled-<timestamp>.<ext from MIME>` as the final fallback
 *
 *  Output is always sanitized so path separators and `..` can't escape the
 *  caller's `dest` directory. */
function deriveFilename(
  url: URL,
  contentDisposition: string | null,
  mime: string,
): string {
  // 1. Content-Disposition — server knows best when present.
  const fromCd = parseContentDispositionFilename(contentDisposition);
  if (fromCd) {
    const safe = sanitizeFilename(fromCd);
    if (safe) return safe;
  }

  // 2. URL last path segment, only if it carries an extension.
  try {
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last) {
      const decoded = decodeURIComponent(last);
      if (decoded.includes('.')) {
        const safe = sanitizeFilename(decoded);
        if (safe) return safe;
      }
    }
  } catch {
    // decodeURIComponent can throw on malformed input — just fall through.
  }

  // 3. Fallback. Timestamp keeps successive saves to the same dir distinct.
  return `Untitled-${Date.now()}.${extensionForMime(mime)}`;
}

/** Pull the filename out of a `Content-Disposition` header. RFC 6266 says
 *  the RFC 5987-encoded `filename*` parameter wins over the legacy ASCII
 *  `filename` when both are present. Both regexes anchor on a parameter
 *  boundary (`^` or `;`) so we never match the value half of an adjacent
 *  parameter like `xfilename=...`. */
function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  // filename*=<charset>'<lang>'<percent-encoded>  (RFC 5987)
  const star = header.match(/(?:^|;)\s*filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i);
  if (star) {
    const charset = (star[1] ?? '').toUpperCase();
    // RFC 5987 forbids quoting the ext-value, but tolerate non-conforming
    // servers that wrap it in quotes anyway.
    const encoded = (star[2] ?? '').trim().replace(/^"|"$/g, '');
    if (charset === '' || charset === 'UTF-8' || charset === 'US-ASCII') {
      try { return decodeURIComponent(encoded); } catch { /* malformed, fall through */ }
    }
  }
  // filename="..." or filename=...
  const plain = header.match(/(?:^|;)\s*filename\s*=\s*("([^"]*)"|([^;]+))/i);
  if (plain) {
    return (plain[2] ?? plain[3] ?? '').trim() || null;
  }
  return null;
}

/** Sanitize a filename string so it cannot escape its parent directory.
 *  Strips path separators, null bytes, and leading dots (so `.htaccess`
 *  becomes `htaccess` — acceptable trade-off; the rule also kills the `.`
 *  / `..` special cases); collapses `..` sequences; caps length so a
 *  pathological multi-KB filename from a misbehaving server can't poison
 *  the VFS file tree. Returns empty string if nothing usable remains. */
function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[/\\\0]/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  // 255 chars is the typical filesystem limit; IndexedDB doesn't enforce
  // it but downstream UI (breadcrumbs, file tree) renders poorly past it.
  return cleaned.slice(0, 255);
}

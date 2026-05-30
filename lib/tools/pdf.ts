import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_PDF } from '@/lib/types';
import { vfs } from '@/lib/vfs';
import { ensureOffscreen } from './offscreen';
import type {
  OffscreenRequest,
  OffscreenPdfInfoResponse,
  OffscreenPdfTextResponse,
  OffscreenPdfSearchResponse,
} from '@/entrypoints/offscreen/main';
import type {
  PdfInfo,
  PdfSearchResult,
  PdfOutlineEntry,
} from '@/entrypoints/offscreen/pdf';

// ─── PDF detection helper (shared with read_page in Task 4) ───

/** Best-effort URL-only PDF detection. Strips query/hash, checks `.pdf`
 *  suffix on the pathname. Intentionally fast and stateless — no network,
 *  no script injection. The offscreen service still validates the actual
 *  `Content-Type` when bytes are fetched, so a false positive here just
 *  produces a clean error message; a false negative means the user can
 *  ask the agent to use `pdf` explicitly. */
export function isLikelyPdfUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') {
      return false;
    }
    return u.pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

/** Hint text shown when something tried to read a PDF tab via a non-PDF
 *  path (e.g. `read_page`). Lives here so the PDF tool's API surface is
 *  the single source of truth — callers don't hard-code parameter names
 *  that may evolve. Only mentions `tabId` (universal across tools) and the
 *  three stable action keywords. */
export function pdfRedirectHint(tabUrl: string | undefined, tabId: number): string {
  const urlSuffix = tabUrl ? ` (url: ${tabUrl})` : '';
  return (
    `This tab appears to be a PDF${urlSuffix}. ` +
    '`read_page` cannot extract canvas-rendered PDF text — use the `pdf` tool instead. ' +
    `Pass \`tabId: ${tabId}\` and pick \`action\`: "info" for the page count and outline, ` +
    '"read" to extract text, or "search" to find specific content. ' +
    'See the `pdf` tool description for the full parameter list.'
  );
}

// ─── Schema ───

const PdfParameters = Type.Object({
  action: Type.Union(
    [Type.Literal('info'), Type.Literal('read'), Type.Literal('search')],
    {
      description:
        'Which operation to perform on the PDF tab. ' +
        '"info" returns metadata (page count, title, author, outline). ' +
        '"read" extracts text (use `pageRange` to target specific pages). ' +
        '"search" finds occurrences of `query` and returns page numbers + snippets.',
    },
  ),
  tabId: Type.Number({
    description:
      'Required. Tab ID to read from. Read it from the `tabId:` line under `[Active Tab]` ' +
      '(or the windows list) in the context block. Never omit — the active tab may have ' +
      'changed since the last context snapshot. The tab must be displaying a PDF; the tool ' +
      'fetches the PDF bytes from the tab\'s URL and parses them inside the offscreen ' +
      'document.',
  }),
  pageRange: Type.Optional(
    Type.String({
      description:
        'Optional. Restrict `read`/`search` to a subset of pages. Accepts a single page ' +
        '("5"), an inclusive range ("1-10"), or a comma-combined list ("1-3,7,10-12"). ' +
        '1-based. Out-of-range parts are clamped silently. Omit to cover every page.',
    }),
  ),
  maxLength: Type.Optional(
    Type.Number({
      description:
        'Optional, only used by `action: "read"`. Maximum character length of the returned ' +
        'text. Defaults to 20000. Truncated responses end with a ' +
        '"...(truncated at N chars)" marker. Ignored entirely when `outputPath` is set.',
    }),
  ),
  outputPath: Type.Optional(
    Type.String({
      description:
        'Optional, only used by `action: "read"`. If set, the full extracted text is written ' +
        'to this absolute VFS path (e.g. "/workspaces/abc/paper.txt") and only a short ' +
        'summary is returned to you. `maxLength` is ignored when this is set. Parent ' +
        'directories are created automatically. Existing files are overwritten.',
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        'Required for `action: "search"`. The text or regex to look for inside the PDF. ' +
        'Treated as a literal substring unless `regex: true`.',
    }),
  ),
  regex: Type.Optional(
    Type.Boolean({
      description:
        'Optional, default false. When true, `query` is compiled as a JavaScript regular ' +
        'expression. Invalid regex returns a clear error.',
    }),
  ),
  caseInsensitive: Type.Optional(
    Type.Boolean({
      description:
        'Optional, default true. When false, search is case-sensitive.',
    }),
  ),
  maxHits: Type.Optional(
    Type.Number({
      description:
        'Optional, only used by `action: "search"`. Cap on total hits returned. Defaults ' +
        'to 50, hard-capped at 500. Hit cap reached → response notes truncation.',
    }),
  ),
});

type PdfToolParams = Static<typeof PdfParameters>;

// ─── Constants ───

/** Wall-clock timeout for any single offscreen call. Large PDFs occasionally
 *  push past 30s in cold runs; 60s is generous without leaving the agent
 *  hanging on a hung worker. */
const PDF_CALL_TIMEOUT_MS = 60_000;

/** Default character cap on `read` output when neither `maxLength` nor
 *  `outputPath` is provided. Matches the read_page convention. */
const DEFAULT_MAX_LENGTH = 20_000;

// ─── Tool ───

export const pdfTool: AgentTool<typeof PdfParameters> = {
  name: TOOL_PDF,
  label: 'PDF',
  description:
    'Read and search PDF documents that the user has open in a tab. ' +
    'Use this whenever the active tab is a PDF — Chrome\'s built-in PDF viewer renders text ' +
    'to canvas, so the regular `read_page` tool returns empty content for PDFs. ' +
    'Three actions: ' +
    '"info" (page count, title, author, table of contents), ' +
    '"read" (extract text by page range, supports `outputPath` for large docs), ' +
    '"search" (find a substring or regex and return page numbers + snippets). ' +
    'Always supply `tabId`. The tool fetches the PDF bytes from the tab\'s URL and parses ' +
    'them inside the offscreen document; if the browser sandbox refuses the fetch (e.g. for ' +
    'local file:// URLs without the "Allow access to file URLs" toggle, or page-scoped ' +
    'blob: URLs), the error message will surface the actual fetch failure.',
  parameters: PdfParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{}>> {
    signal?.throwIfAborted();
    // ── Resolve tab → URL ──
    const tab = await chrome.tabs.get(params.tabId);
    const url = tab.url;
    if (!url) {
      throw new Error(
        `Tab ${params.tabId} has no URL accessible to the extension ` +
        '(restricted pages like chrome://, the Web Store, or new-tab pages cannot be read).',
      );
    }

    // URL 可 parse 校验。不再白名单协议 —— fetch 出问题了自己报错就行，
    // 与其在工具层猜测哪些协议能 / 不能工作不如让浏览器说实话。
    try {
      new URL(url);
    } catch {
      throw new Error(`Tab URL is not a valid URL: ${url}`);
    }

    await ensureOffscreen();
    signal?.throwIfAborted();

    switch (params.action) {
      case 'info':
        return await runInfo(url);
      case 'read':
        return await runRead(url, params, signal);
      case 'search':
        return await runSearch(url, params, signal);
      default:
        throw new Error(`Unknown action: ${(params as { action?: string }).action}`);
    }
  },
};

// ─── Action handlers ───

async function runInfo(url: string): Promise<AgentToolResult<{}>> {
  const req: OffscreenRequest = { type: 'pdf-info', url };
  const resp = await sendOffscreenWithTimeout<OffscreenPdfInfoResponse>(req);
  if (resp.error) throw new Error(resp.error);
  if (!resp.result) throw new Error('PDF info handler returned no result.');
  return {
    content: [{ type: 'text', text: formatInfo(resp.result) }],
    details: {},
  };
}

async function runRead(
  url: string,
  params: PdfToolParams,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<{}>> {
  const usingOutputPath = !!params.outputPath;
  const maxLength = params.maxLength ?? DEFAULT_MAX_LENGTH;

  // `maxChars` is the *hard cap* we ask the offscreen layer to enforce
  // before returning bytes. When writing to VFS we don't cap (the whole
  // point is to dump everything to disk). Inline mode caps slightly above
  // `maxLength` so we can add the truncation marker without overflowing.
  const offscreenMaxChars = usingOutputPath ? undefined : maxLength + 200;

  const req: OffscreenRequest = {
    type: 'pdf-text',
    url,
    pageRange: params.pageRange,
    maxChars: offscreenMaxChars,
  };
  const resp = await sendOffscreenWithTimeout<OffscreenPdfTextResponse>(req);
  if (resp.error) throw new Error(resp.error);
  if (!resp.result) throw new Error('PDF text handler returned no result.');
  signal?.throwIfAborted();

  const { text, pages, truncated } = resp.result;

  // ── outputPath branch ──
  if (params.outputPath) {
    await vfs.writeFile(params.outputPath, text, 'utf8');
    const byteLen = new TextEncoder().encode(text).length;
    const preview = text.length > 1024
      ? text.slice(0, 1024) + '\n…(preview truncated; full content is on disk)'
      : text;
    const pageSummary = describePageSelection(pages);
    return {
      content: [{
        type: 'text',
        text:
          `Wrote ${params.outputPath} (${byteLen} bytes, ${pageSummary}).\n` +
          `Preview:\n---\n${preview}\n---`,
      }],
      details: {},
    };
  }

  // ── inline branch with maxLength truncation ──
  const body = truncated || text.length > maxLength
    ? text.slice(0, maxLength) + `\n\n...(truncated at ${maxLength} chars)`
    : text;
  return {
    content: [{ type: 'text', text: body }],
    details: {},
  };
}

async function runSearch(
  url: string,
  params: PdfToolParams,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<{}>> {
  if (!params.query || !params.query.trim()) {
    throw new Error('Search requires a non-empty `query`.');
  }
  const req: OffscreenRequest = {
    type: 'pdf-search',
    url,
    query: params.query,
    pageRange: params.pageRange,
    regex: params.regex,
    caseInsensitive: params.caseInsensitive,
    maxHits: params.maxHits,
  };
  const resp = await sendOffscreenWithTimeout<OffscreenPdfSearchResponse>(req);
  if (resp.error) throw new Error(resp.error);
  if (!resp.result) throw new Error('PDF search handler returned no result.');
  signal?.throwIfAborted();
  return {
    content: [{ type: 'text', text: formatSearch(params.query, resp.result) }],
    details: {},
  };
}

// ─── Formatting ───

function formatInfo(info: PdfInfo): string {
  const lines: string[] = [];
  lines.push(`Page count: ${info.pageCount}`);
  if (info.title) lines.push(`Title: ${info.title}`);
  if (info.author) lines.push(`Author: ${info.author}`);
  if (info.subject) lines.push(`Subject: ${info.subject}`);
  if (info.keywords) lines.push(`Keywords: ${info.keywords}`);
  if (info.creationDate) {
    const formatted = formatPdfDate(info.creationDate);
    lines.push(`Created: ${formatted}`);
  }

  if (info.outline.length > 0) {
    lines.push('');
    lines.push(`Outline${info.outlineTruncated ? ' (truncated)' : ''}:`);
    for (const entry of info.outline) {
      lines.push(formatOutlineEntry(entry));
    }
  } else {
    lines.push('Outline: (none)');
  }

  return lines.join('\n');
}

function formatOutlineEntry(entry: PdfOutlineEntry): string {
  const indent = '  '.repeat(entry.level + 1);
  const pageSuffix = entry.page != null ? ` (p. ${entry.page})` : '';
  return `${indent}- ${entry.title}${pageSuffix}`;
}

/** Parse a PDF date string ("D:YYYYMMDDHHmmSSOHH'mm'") into a readable
 *  form. Returns the raw string on parse failure so we never lose data.
 *  Timezone suffix is intentionally elided — the wall-clock
 *  year/month/day is what humans care about; PDFs rarely carry a
 *  meaningful TZ anyway. */
function formatPdfDate(raw: string): string {
  const m = raw.match(/^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return raw;
  const [, y, mo, d, h, mi, s] = m;
  let out = y;
  if (mo) out += `-${mo}`;
  if (d) out += `-${d}`;
  if (h) out += ` ${h}`;
  if (mi) out += `:${mi}`;
  if (s) out += `:${s}`;
  return out;
}

function formatSearch(query: string, result: PdfSearchResult): string {
  if (result.hits.length === 0) {
    return `No matches found for "${query}" across ${result.pagesScanned} page(s).`;
  }
  const lines: string[] = [];
  const pagesWithHits = new Set(result.hits.map(h => h.page)).size;
  const header = result.truncated
    ? `Found ${result.hits.length}+ matches for "${query}" across ${pagesWithHits} page(s) (result capped):`
    : `Found ${result.hits.length} match(es) for "${query}" across ${pagesWithHits} page(s):`;
  lines.push(header);
  lines.push('');
  for (const hit of result.hits) {
    // Single-line snippet — collapse internal newlines so the listing stays compact.
    const snippet = hit.snippet.replace(/\s+/g, ' ').trim();
    lines.push(`[Page ${hit.page}] ${snippet}`);
  }
  return lines.join('\n');
}

function describePageSelection(includedPages: number[]): string {
  if (includedPages.length === 0) return '0 pages';
  const first = includedPages[0];
  const last = includedPages[includedPages.length - 1];
  const range = first === last ? `page ${first}` : `pages ${first}-${last}`;
  // outputPath 路径下 offscreenMaxChars 为 undefined，不会发生截断，
  // 所以这里只描述完整页码范围。
  return `${range}, ${includedPages.length} page(s) total`;
}

// ─── Offscreen call with timeout ───

/** Send a request to the offscreen document and resolve with the typed
 *  response. Wraps in a hard timeout so a stuck worker can't permanently
 *  hang the agent loop — the agent can still cancel via signal, but for
 *  cases where the worker silently never responds we need a safety net. */
async function sendOffscreenWithTimeout<R extends { result?: unknown; error?: string }>(
  req: OffscreenRequest,
): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<R>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`PDF operation timed out after ${PDF_CALL_TIMEOUT_MS / 1000}s.`));
    }, PDF_CALL_TIMEOUT_MS);
  });
  try {
    const resp = await Promise.race([
      chrome.runtime.sendMessage(req) as Promise<R>,
      timeout,
    ]);
    return resp;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

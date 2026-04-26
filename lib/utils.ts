import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Compact character-count formatter for UI tooltips: `999`, `1.2K`, `3.4M`.
 *  Drops trailing `.0` so `1000 → 1K`, not `1.0K`. Negatives are clamped to 0. */
export function formatCharCount(n: number): string {
  const v = Math.max(0, Math.floor(n));
  if (v < 1000) return String(v);
  const fmt = (x: number) => x.toFixed(1).replace(/\.0$/, '');
  if (v < 1_000_000) return `${fmt(v / 1000)}K`;
  return `${fmt(v / 1_000_000)}M`;
}

/** Format a millisecond duration as `M:SS` (or `H:MM:SS` past one hour). */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

/** Short random id for collision-tolerant uses (event ids, filename suffixes,
 *  cache-buster keys). NOT a UUID — don't use for security or anything that
 *  must be globally unique. Default base is 36 (alphanumeric). */
export function randomId(length = 8, base: 16 | 36 = 36): string {
  let out = '';
  while (out.length < length) {
    out += Math.random().toString(base).slice(2);
  }
  return out.slice(0, length);
}

/** Trigger a browser download of `content` as a file named `name` with the
 *  given `mimeType`. Works for strings (JSON, text), Blobs, and ArrayBuffers.
 *  The object URL is revoked after a short delay so the download can start. */
export function downloadFile(name: string, content: string | Blob | ArrayBuffer, mimeType: string): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Escape `&` and `<` (and `"` when `forAttribute: true`) for safe inclusion
 *  in XML. Use the default for element text content; pass `{forAttribute:true}`
 *  for attribute values.
 *
 *  `>` is intentionally left raw in most cases — XML §2.4 only requires it
 *  escaped in character data when it forms the sequence `]]>`, which we
 *  handle explicitly below. Keeping raw `>` saves noticeable tokens on
 *  selector-heavy payloads like recording bodies.
 *
 *  Attribute mode assumes the caller wraps values in double quotes (we
 *  never emit single-quoted attributes); `'` is therefore not escaped.
 *
 *  Order matters: `&` must come first so we don't double-escape the
 *  entities we just produced. */
export function escapeXml(s: string, opts?: { forAttribute?: boolean }): string {
  let out = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/]]>/g, ']]&gt;');
  if (opts?.forAttribute) out = out.replace(/"/g, '&quot;');
  return out;
}

/** Reverse `escapeXml`. Still decodes `&gt;` so older payloads round-trip
 *  correctly, even though the current encoder no longer produces it. Order
 *  matters: `&amp;` must come last to avoid corrupting entity sequences that
 *  contain a literal `&` (e.g. text that originally said `&amp;lt;`). */
export function unescapeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 把一个不可信的值当字符串取：是 string 就原样返回，否则回退到 `fallback`。用于规整
 *  来自 IPC / 备份 / 外部 JSON 等不受类型约束的输入。 */
export function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** `crypto.randomUUID()` 输出形态（小写 UUID v4）。 */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 校验一个值是否是合法会话 id（`crypto.randomUUID()` 形态）。会话 id 会被插进路径
 *  （`/workspaces/<id>`）与备份文件名，畸形值经 `vfs.rm` 等操作可能逃逸目录，故所有
 *  消息 / 备份边界都先用它把关。单一事实源——持久层、备份、agent 工具、background
 *  共用此谓词，不各写一份正则。 */
export function isValidSessionId(id: unknown): boolean {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
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

/** Escape regex metacharacters in a string so it can be embedded inside a
 *  `RegExp` source as a literal match. Generic — no callers required to
 *  be source code-related. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把 Uint8Array 编码成 base64。逐块切片避免 `String.fromCharCode(...bytes)`
 * 在大数组（>~120 KB）触发 stack overflow。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  // 32 KB —— 远低于 V8 默认 arg 数上限，保证 fromCharCode.apply 不会爆栈。
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

/** 把 base64 解码回 Uint8Array。 */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * 穷尽检查哨兵：放在判别联合 `switch` 的 `default` 分支，确保每个 `kind`
 * 都被处理——漏掉一个分支时 `x` 不再收窄成 `never`，编译期即报错。
 * 运行期真走到这里（外部传入越界数据）则抛错，避免静默吞掉。
 */
export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${String(x)}`);
}

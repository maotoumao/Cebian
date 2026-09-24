import type { ImageContent } from '@earendil-works/pi-ai';
import { escapeXml } from '@/lib/utils';
import { RECORDING_SCHEMA_COMMENT } from '@/lib/recorder/schema-doc';

// ─── Attachment types ───

export interface ImageAttachment {
  type: 'image';
  source: 'screenshot' | 'upload' | 'paste';
  data: string;          // base64 without data: prefix
  mimeType: string;
  name?: string;
}

export interface TextFileAttachment {
  type: 'file';
  content: string;
  name: string;
  mimeType: string;
  size: number;          // original bytes
}

export interface ElementAttachment {
  type: 'element';
  selector: string;
  tagName: string;
  path: string;          // full path from html root
  attributes: Record<string, string>;
  textContent?: string;  // first 200 chars of innerText
  rect?: { x: number; y: number; width: number; height: number };
  tabId?: number;
  tabUrl?: string;
  windowId?: number;
  frameId?: number;      // 0 or undefined = top frame
  frameUrl?: string;
}

/**
 * A captured user-interaction recording, stored as a JSON string. The agent
 * receives the raw JSON wrapped in a `<recording>` block; the UI shows a
 * download chip. `truncatedAttachment` is set when `events` had to be cut
 * from the end to fit `MAX_RECORDING_SIZE`.
 */
export interface RecordingAttachment {
  type: 'recording';
  /** Display + download filename, e.g. `recording-20260422-1503.json`. */
  name: string;
  /** UTF-8 byte length of `json`. */
  sizeBytes: number;
  eventCount: number;
  durationMs: number;
  /** Serialized RecordedSession. May reflect a truncated session. */
  json: string;
  /** True when events were dropped from the end to fit the size limit. */
  truncatedAttachment?: boolean;
}

export type Attachment = ImageAttachment | TextFileAttachment | ElementAttachment | RecordingAttachment;

/** MIME type for serialized recording JSON. Used for both the agent-prompt
 *  envelope and browser downloads of recording attachments. */
export const RECORDING_MIME = 'application/x-cebian-recording+json';

// ─── Size / type limits ───

export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;      // 5 MB
export const MAX_TEXT_FILE_SIZE = 100 * 1024;         // 100 KB
/** Cap recording JSON to keep prompt budget reasonable (~80k tokens worst case). */
export const MAX_RECORDING_SIZE = 256 * 1024;         // 256 KB
export const MAX_ATTACHMENT_COUNT = 10;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.tsv', '.log',
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.java', '.c', '.cpp', '.h', '.hpp',
  '.go', '.rs', '.rb', '.php', '.sh', '.bash',
  '.sql', '.yaml', '.yml', '.toml', '.ini', '.cfg',
  '.json', '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.env', '.gitignore', '.editorconfig',
]);

const IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
]);

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function isTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.has(getFileExtension(name));
}

function isImageFile(file: File): boolean {
  return IMAGE_MIME_TYPES.has(file.type);
}

// ─── File intake rules ───

export type FileIntakeKind = 'image' | 'text';

export type FileIntakeRejection =
  | { file: File; reason: 'no-image-model' }
  | { file: File; reason: 'too-large'; maxSize: number }
  | { file: File; reason: 'unsupported' };

export interface FileIntakePlan {
  /** 通过校验、且占到了名额的文件，保持传入顺序。 */
  accepted: Array<{ file: File; kind: FileIntakeKind }>;
  /** 类型 / 大小 / 模型能力不合格的文件（不占名额）。 */
  rejected: FileIntakeRejection[];
  /** 本身合格、但名额已满而没有加入的文件数。 */
  skipped: number;
}

/**
 * 判定一批文件（点击上传 / 粘贴 / 拖放共用）能加入哪些附件。纯规则，不读文件内容。
 * 按传入顺序逐个判定，只有合格的文件占名额——前面一个不支持的文件不会挤掉后面合格的。
 */
export function planFileIntake(
  files: readonly File[],
  { remaining, supportsImage }: { remaining: number; supportsImage: boolean },
): FileIntakePlan {
  const plan: FileIntakePlan = { accepted: [], rejected: [], skipped: 0 };
  for (const file of files) {
    let kind: FileIntakeKind;
    if (isImageFile(file)) {
      if (!supportsImage) {
        plan.rejected.push({ file, reason: 'no-image-model' });
        continue;
      }
      if (file.size > MAX_IMAGE_SIZE) {
        plan.rejected.push({ file, reason: 'too-large', maxSize: MAX_IMAGE_SIZE });
        continue;
      }
      kind = 'image';
    } else if (isTextFile(file.name)) {
      if (file.size > MAX_TEXT_FILE_SIZE) {
        plan.rejected.push({ file, reason: 'too-large', maxSize: MAX_TEXT_FILE_SIZE });
        continue;
      }
      kind = 'text';
    } else {
      plan.rejected.push({ file, reason: 'unsupported' });
      continue;
    }
    if (plan.accepted.length < remaining) plan.accepted.push({ file, kind });
    else plan.skipped++;
  }
  return plan;
}

// ─── Build LLM-ready content from attachments ───

/**
 * Build XML text from element and file attachments, wrapped in <attachments>.
 * Returns empty string if there are no element/file attachments.
 */
export function buildTextPrefix(attachments: Attachment[]): string {
  const blocks: string[] = [];

  for (const a of attachments) {
    if (a.type === 'element') {
      const attrs = Object.entries(a.attributes)
        .map(([k, v]) => `${k}="${escapeXml(v, { forAttribute: true })}"`)
        .join(' ');

      const lines = [
        `<selected-element selector="${escapeXml(a.selector, { forAttribute: true })}"${a.frameId ? ` frame-id="${a.frameId}" frame-url="${escapeXml(a.frameUrl ?? '', { forAttribute: true })}"` : ''}>`,
        `  path: ${a.path}`,
        `  tag: ${a.tagName}`,
        `  attributes: ${attrs || '(none)'}`,
      ];
      if (a.textContent) lines.push(`  text: ${a.textContent}`);
      if (a.rect) lines.push(`  rect: ${a.rect.x},${a.rect.y} ${a.rect.width}×${a.rect.height}`);
      lines.push('</selected-element>');
      blocks.push(lines.join('\n'));
    }

    if (a.type === 'file') {
      blocks.push(
        `<attached-file name="${escapeXml(a.name, { forAttribute: true })}" type="${escapeXml(a.mimeType, { forAttribute: true })}">\n${a.content}\n</attached-file>`,
      );
    }

    if (a.type === 'recording') {
      const truncAttr = a.truncatedAttachment ? ' truncated="true"' : '';
      // Element-text-escape the JSON body so arbitrary recorded text
      // (containing `<`, `>`, or `&`) can't break the surrounding XML or
      // the non-greedy <attachments>...</attachments> regex used for
      // parsing. Body is plain readable JSON for the agent (no base64).
      blocks.push(
        `<recording name="${escapeXml(a.name, { forAttribute: true })}" mime="${RECORDING_MIME}" event-count="${a.eventCount}" duration-ms="${a.durationMs}"${truncAttr}>\n${escapeXml(a.json)}\n</recording>`,
      );
    }
  }

  if (blocks.length === 0) return '';

  // When the message carries at least one <recording>, prepend a schema
  // comment so the agent can interpret the JSON body without guessing
  // field meanings. Only inject when relevant to avoid spending tokens
  // on messages that don't need it.
  const hasRecording = attachments.some((a) => a.type === 'recording');
  const body = hasRecording
    ? `${RECORDING_SCHEMA_COMMENT}\n${blocks.join('\n\n')}`
    : blocks.join('\n\n');
  return `<attachments>\n${body}\n</attachments>`;
}

/**
 * Extract ImageContent array from attachments for multi-modal prompt.
 */
export function extractImages(attachments: Attachment[]): ImageContent[] {
  return attachments
    .filter((a): a is ImageAttachment => a.type === 'image')
    .map(a => ({ type: 'image' as const, data: a.data, mimeType: a.mimeType }));
}



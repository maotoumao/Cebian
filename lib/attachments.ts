import type { ImageContent } from '@mariozechner/pi-ai';

// ─── Attachment types ───

export interface ImageAttachment {
  type: 'image';
  source: 'screenshot' | 'upload';
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
  frameId?: number;      // 0 or undefined = top frame
  frameUrl?: string;
}

export type Attachment = ImageAttachment | TextFileAttachment | ElementAttachment;

// ─── Size / type limits ───

export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;      // 5 MB
export const MAX_TEXT_FILE_SIZE = 100 * 1024;         // 100 KB
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

export function getFileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export function isTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.has(getFileExtension(name));
}

export function isImageFile(file: File): boolean {
  return IMAGE_MIME_TYPES.has(file.type);
}

// ─── Build LLM-ready content from attachments ───

/**
 * Build XML text prefix from element and file attachments.
 * This text is prepended to the user message before page context.
 */
export function buildTextPrefix(attachments: Attachment[]): string {
  const blocks: string[] = [];

  for (const a of attachments) {
    if (a.type === 'element') {
      const attrs = Object.entries(a.attributes)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ');

      const lines = [
        `<selected-element selector="${a.selector}"${a.frameId ? ` frame-id="${a.frameId}" frame-url="${a.frameUrl ?? ''}"` : ''}>`,
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
        `<attached-file name="${a.name}" type="${a.mimeType}">\n${a.content}\n</attached-file>`,
      );
    }
  }

  return blocks.join('\n\n');
}

/**
 * Extract ImageContent array from attachments for multi-modal prompt.
 */
export function extractImages(attachments: Attachment[]): ImageContent[] {
  return attachments
    .filter((a): a is ImageAttachment => a.type === 'image')
    .map(a => ({ type: 'image' as const, data: a.data, mimeType: a.mimeType }));
}

/**
 * Format file size for display (e.g. "2.3 KB", "1.1 MB").
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

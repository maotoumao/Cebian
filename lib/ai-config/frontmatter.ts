/**
 * YAML frontmatter parser/serializer for Prompt and Skill files.
 *
 * Uses `front-matter` for parsing (browser-compatible, no Buffer dependency).
 * Serialization uses simple string building for the flat YAML structures we use.
 */
import fm from 'front-matter';

export interface ParsedFrontmatter {
  /** Parsed YAML data as a plain object. */
  data: Record<string, unknown>;
  /** Markdown body after the closing `---`. */
  body: string;
}

/**
 * Parse YAML frontmatter from a Markdown file.
 * Returns `{ data: {}, body: fullContent }` if no frontmatter is found.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const result = fm<Record<string, unknown>>(content);
  return {
    data: result.attributes,
    body: result.body,
  };
}

/** Simple YAML serializer for flat/shallow objects. */
function serializeYaml(data: Record<string, unknown>, indent = 0): string {
  const prefix = '  '.repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      lines.push(`${prefix}${key}:`);
      lines.push(serializeYaml(value as Record<string, unknown>, indent + 1));
    } else if (Array.isArray(value)) {
      lines.push(`${prefix}${key}:`);
      for (const item of value) {
        const formatted = typeof item === 'string' ? JSON.stringify(item) : String(item);
        lines.push(`${prefix}  - ${formatted}`);
      }
    } else if (typeof value === 'string') {
      lines.push(`${prefix}${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${prefix}${key}: ${String(value)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Serialize data + body back into a frontmatter Markdown string.
 */
export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const yaml = serializeYaml(data);
  return `---\n${yaml}\n---\n${body}`;
}

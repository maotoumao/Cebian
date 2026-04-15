/**
 * YAML frontmatter parser/serializer for Prompt and Skill files.
 *
 * Uses gray-matter under the hood for robust YAML handling.
 */
import matter from 'gray-matter';

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
  const result = matter(content);
  return {
    data: result.data as Record<string, unknown>,
    body: result.content,
  };
}

/**
 * Serialize data + body back into a frontmatter Markdown string.
 */
export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  return matter.stringify(body, data);
}

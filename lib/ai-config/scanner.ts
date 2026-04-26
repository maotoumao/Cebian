//
// VFS scanner for Prompts and Skills.
//
// - Prompts: reads ~/.cebian/prompts/*.md, parses frontmatter (name + description).
// - Skills: reads ~/.cebian/skills/<name>/SKILL.md, parses frontmatter.
//
// Skill index is cached in-memory with a 30-minute TTL and can be proactively invalidated.
//
import { vfs } from '@/lib/vfs';
import { CEBIAN_PROMPTS_DIR, CEBIAN_SKILLS_DIR, SKILL_ENTRY_FILE, SKILLS_PREAMBLE } from '@/lib/constants';
import { escapeXml } from '@/lib/utils';
import { parseFrontmatter } from './frontmatter';

// ─── Types ───

export interface PromptMeta {
  name: string;
  description: string;
  fileName: string;        // e.g. "translate.md"
  filePath: string;        // e.g. "~/.cebian/prompts/translate.md"
}

export interface SkillMeta {
  name: string;
  description: string;
  metadata?: Record<string, unknown>;
  compatibility?: string;
  allowedTools?: string;
  filePath: string;        // e.g. "~/.cebian/skills/web-summary/SKILL.md"
}

// ─── Constants ───

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ─── Skill Index Cache ───

let _skillIndex: SkillMeta[] | null = null;
let _skillIndexTimestamp = 0;

/** Clear the cached skill index. Call when skills are modified. */
export function invalidateSkillIndex(): void {
  _skillIndex = null;
  _skillIndexTimestamp = 0;
}

// ─── Prompt Scanner ───

/**
 * Scan ~/.cebian/prompts/ for all .md files and parse their frontmatter.
 * No caching — prompts are only scanned when the UI or `/` menu opens.
 */
export async function scanPrompts(): Promise<PromptMeta[]> {
  const results: PromptMeta[] = [];

  let entries: string[];
  try {
    entries = await vfs.readdir(CEBIAN_PROMPTS_DIR);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;

    const filePath = `${CEBIAN_PROMPTS_DIR}/${entry}`;
    try {
      const raw = await vfs.readFile(filePath, 'utf8');
      const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      const { data } = parseFrontmatter(content);
      const name = typeof data.name === 'string' ? data.name : entry.replace(/\.md$/, '');
      const description = typeof data.description === 'string' ? data.description : '';
      results.push({ name, description, fileName: entry, filePath });
    } catch {
      // Skip unreadable files
    }
  }

  return results;
}

// ─── Skill Scanner ───

/**
 * Scan ~/.cebian/skills/ for all skill directories and parse their SKILL.md frontmatter.
 * Uses an in-memory cache with 30s TTL.
 */
export async function scanSkillIndex(): Promise<SkillMeta[]> {
  // Return cache if still valid
  if (_skillIndex && Date.now() - _skillIndexTimestamp < CACHE_TTL_MS) {
    return _skillIndex;
  }

  const results: SkillMeta[] = [];

  let skillDirs: string[];
  try {
    skillDirs = await vfs.readdir(CEBIAN_SKILLS_DIR);
  } catch {
    _skillIndex = results;
    _skillIndexTimestamp = Date.now();
    return results;
  }

  for (const dirName of skillDirs) {
    const skillMdPath = `${CEBIAN_SKILLS_DIR}/${dirName}/${SKILL_ENTRY_FILE}`;

    try {
      // Check it's actually a directory (stat then check)
      const stat = await vfs.stat(`${CEBIAN_SKILLS_DIR}/${dirName}`);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    try {
      const raw = await vfs.readFile(skillMdPath, 'utf8');
      const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      const { data } = parseFrontmatter(content);

      const metadata = data.metadata && typeof data.metadata === 'object'
        ? data.metadata as Record<string, unknown>
        : undefined;

      // Skills can opt out of the agent index by setting metadata.disabled: true.
      if (metadata?.disabled === true) continue;

      const name = typeof data.name === 'string' ? data.name : dirName;
      const description = typeof data.description === 'string' ? data.description : '';

      const meta: SkillMeta = { name, description, filePath: skillMdPath };

      if (metadata) {
        meta.metadata = metadata;
      }
      if (typeof data.compatibility === 'string') {
        meta.compatibility = data.compatibility;
      }
      if (typeof data['allowed-tools'] === 'string') {
        meta.allowedTools = data['allowed-tools'];
      }

      results.push(meta);
    } catch {
      // Skip skills without a valid SKILL.md
    }
  }

  _skillIndex = results;
  _skillIndexTimestamp = Date.now();
  return results;
}

// ─── Skill Index → XML Builder ───

/**
 * Build the <skills>...</skills> XML block for injection into <agent-config>.
 * Returns an empty string if no skills exist.
 */
export function buildSkillsBlock(metas: SkillMeta[]): string {
  if (metas.length === 0) return '';

  const skillEntries = metas.map((s) => {
    const lines: string[] = [];
    lines.push('<skill>');
    lines.push(`<name>${escapeXml(s.name)}</name>`);
    lines.push(`<description>${escapeXml(s.description)}</description>`);

    if (s.metadata && Object.keys(s.metadata).length > 0) {
      const metaLines = Object.entries(s.metadata).map(([k, v]) => {
        if (Array.isArray(v)) {
          return `  ${k}:\n${v.map(item => `    - ${item}`).join('\n')}`;
        }
        return `  ${k}: ${JSON.stringify(v)}`;
      });
      lines.push(`<metadata>\n${metaLines.join('\n')}\n</metadata>`);
    }

    lines.push(`<file>${s.filePath}</file>`);
    lines.push('</skill>');
    return lines.join('\n');
  });

  return `<skills>\n${SKILLS_PREAMBLE}\n\nAvailable skills:\n${skillEntries.join('\n')}\n</skills>`;
}

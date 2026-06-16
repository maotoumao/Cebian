//
// VFS scanner for Prompts and Skills.
//
// - Prompts: reads ~/.cebian/prompts/*.md, parses frontmatter (name + description).
// - Skills: reads ~/.cebian/skills/<name>/SKILL.md, parses frontmatter.
//
// Skill index is cached in-memory with a 30-minute TTL and can be proactively invalidated.
//
import { vfs, normalizePath } from '@/lib/persistence/vfs';
import { CEBIAN_PROMPTS_DIR, CEBIAN_SKILLS_DIR, SKILL_ENTRY_FILE } from '@/lib/persistence/vfs-paths';
import { escapeXml } from '@/lib/utils';
import { parseFrontmatter } from '@/lib/content/frontmatter';

// ─── Skills preamble ───

const SKILLS_PREAMBLE = `Skills are vetted, domain-specific instruction packs. Each skill folder contains rules
(naming, structure, required fields, trigger conditions) the native tools alone do not encode.

Before acting on a user request, scan the <skill> entries below and decide:

A clear match exists when EITHER of the following is true:
  • a token in the skill's name appears (in any language, including transliteration —
    e.g. "\u767e\u5ea6" matches "baidu", "\u641c\u7d22" matches "search") in the user's request, OR
  • the user's request is a concrete instance of the action the description names.

matched-url metadata, when present, only filters out skills whose glob does not
cover the active tab — it never makes a skill match on its own.

When there is a clear match, fs_read_file the skill's SKILL.md FIRST, then follow it —
even when native tools (interact, execute_js, chrome_api, etc.) look sufficient. The
skill exists because the naive native-tool path gets details wrong (selectors, ordering,
required parameters, output format).

When no entry matches, proceed with native tools. Do not open SKILL.md speculatively.

If you are unsure whether a skill matches, prefer reading it over skipping it: a single
fs_read_file is cheaper than asking the user a clarifying question or producing a wrong
result.

A skill is a directory. When SKILL.md tells you to use a sibling file (assets/,
references/, scripts/), fs_read_file it before acting — SKILL.md only describes those
files abstractly.`;

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

/** Clear the cached skill index. Called by the vfs.onChange listener below
 *  whenever a path under `~/.cebian/skills/` is touched; no external caller
 *  needs to invoke this directly anymore. */
function invalidateSkillIndex(): void {
  _skillIndex = null;
  _skillIndexTimestamp = 0;
}

// ─── Auto-invalidation on VFS mutations ───

const SKILLS_ROOT = normalizePath(CEBIAN_SKILLS_DIR);

function pathTouchesSkills(p: string): boolean {
  return p === SKILLS_ROOT || p.startsWith(SKILLS_ROOT + '/');
}

// Module-level side effect: subscribe once when this module is first
// imported. scanner.ts is imported eagerly by agent-manager.ts and
// background/index.ts, so the listener is wired during SW boot before
// any tool runs.
//
// Cross-context invalidation also flows through this listener: a UI write
// to ~/.cebian/skills/ is broadcast via chrome.runtime by vfs.emitChange,
// the SW's vfs bridge re-emits locally, and this listener fires — keeping
// the SW's in-memory cache in sync without any manual sendMessage hop.
//
// Also handles renames where ONLY the old path is in the skills tree
// (e.g. moving a SKILL.md OUT of ~/.cebian/skills/) — the previous
// per-tool path-checker inspected just one path and would miss this case.
vfs.onChange((event) => {
  if (pathTouchesSkills(event.path)) {
    invalidateSkillIndex();
    return;
  }
  if (event.kind === 'rename' && pathTouchesSkills(event.oldPath)) {
    invalidateSkillIndex();
  }
});

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

  // 按 filePath 确定性排序：skills 索引已迁入被缓存的 system prompt，相同的 skills
  // 集合必须产出逐字节相同的字符串才能命中 prompt cache。vfs.readdir 返回的是
  // 目录插入顺序（非字典序，且随增删 / SW 冷启抖动），不可依赖；filePath 内嵌唯一
  // dirName、永远存在、天然唯一，是稳定排序键。
  results.sort((a, b) => a.filePath.localeCompare(b.filePath));

  _skillIndex = results;
  _skillIndexTimestamp = Date.now();
  return results;
}

// ─── Skill Index → XML Builder ───

/**
 * Build the <skills>...</skills> XML block.
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

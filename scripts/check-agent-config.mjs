#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');

const skills = [
  'cl',
  'code-review',
  'i18n-naming',
  'shadcn',
  'start-task',
  'upgrade-packages',
  'upgrade-pi',
  'vercel-react-best-practices',
];
const manualSkills = new Set([
  'cl',
  'start-task',
  'upgrade-packages',
  'upgrade-pi',
]);
const errors = [];

async function read(relativePath) {
  try {
    return await fs.readFile(path.join(root, relativePath), 'utf8');
  } catch {
    errors.push(`Missing file: ${relativePath}`);
    return '';
  }
}

async function exists(relativePath) {
  try {
    await fs.access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function parseFrontmatter(relativePath, content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    errors.push(`Invalid frontmatter: ${relativePath}`);
    return {};
  }

  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([a-z][a-z0-9-]*):\s*(.*)$/);
    if (field) fields[field[1]] = parseScalar(field[2]);
  }
  return fields;
}

function requireText(relativePath, content, expected) {
  if (!content.includes(expected)) {
    errors.push(`${relativePath} must contain: ${expected}`);
  }
}

function quotedYamlValue(content, key) {
  const match = content.match(new RegExp(`^\\s*${key}:\\s*"([^"]*)"\\s*$`, 'm'));
  return match?.[1] ?? '';
}

async function checkSkill(name) {
  const canonicalPath = `.agents/skills/${name}/SKILL.md`;
  const canonical = await read(canonicalPath);
  const canonicalFields = parseFrontmatter(canonicalPath, canonical);
  const canonicalKeys = Object.keys(canonicalFields).sort();

  if (canonicalFields.name !== name) {
    errors.push(`${canonicalPath} name must be ${name}`);
  }
  if (!canonicalFields.description) {
    errors.push(`${canonicalPath} must define description`);
  }
  if (canonicalKeys.join(',') !== 'description,name') {
    errors.push(`${canonicalPath} may only define name and description`);
  }
  if (canonical.includes('!`')) {
    errors.push(`${canonicalPath} contains Claude-only dynamic command syntax`);
  }

  for (const host of ['.claude', '.github']) {
    const adapterPath = `${host}/skills/${name}/SKILL.md`;
    const adapter = await read(adapterPath);
    const adapterFields = parseFrontmatter(adapterPath, adapter);

    if (adapterFields.name !== canonicalFields.name) {
      errors.push(`${adapterPath} name differs from canonical skill`);
    }
    if (adapterFields.description !== canonicalFields.description) {
      errors.push(`${adapterPath} description differs from canonical skill`);
    }
    requireText(
      adapterPath,
      adapter,
      `../../../.agents/skills/${name}/SKILL.md`,
    );
    if ('background' in adapterFields) {
      errors.push(`${adapterPath} uses unsupported Skill field: background`);
    }
    if (manualSkills.has(name) && adapterFields['disable-model-invocation'] !== 'true') {
      errors.push(`${adapterPath} must disable model invocation`);
    }
  }

  const openaiPath = `.agents/skills/${name}/agents/openai.yaml`;
  const openai = await read(openaiPath);
  requireText(openaiPath, openai, 'display_name:');
  requireText(openaiPath, openai, 'short_description:');
  requireText(openaiPath, openai, 'default_prompt:');
  requireText(openaiPath, openai, `$${name}`);
  const shortDescription = quotedYamlValue(openai, 'short_description');
  if (shortDescription.length < 25 || shortDescription.length > 64) {
    errors.push(`${openaiPath} short_description must be 25-64 characters`);
  }
  if (manualSkills.has(name)) {
    requireText(openaiPath, openai, 'allow_implicit_invocation: false');
  }
  if (await exists(`.agents/skills/${name}/agents/openai.yml`)) {
    errors.push(`Use openai.yaml, not openai.yml, for skill: ${name}`);
  }

  if (name === 'code-review') {
    const claudeAdapter = await read('.claude/skills/code-review/SKILL.md');
    const copilotAdapter = await read('.github/skills/code-review/SKILL.md');
    requireText('.claude/skills/code-review/SKILL.md', claudeAdapter, 'context: fork');
    requireText('.claude/skills/code-review/SKILL.md', claudeAdapter, 'agent: code-review');
    requireText('.github/skills/code-review/SKILL.md', copilotAdapter, 'context: fork');
  }
  if (name === 'shadcn') {
    const claudeAdapter = await read('.claude/skills/shadcn/SKILL.md');
    const copilotAdapter = await read('.github/skills/shadcn/SKILL.md');
    requireText('.claude/skills/shadcn/SKILL.md', claudeAdapter, 'user-invocable: false');
    requireText('.github/skills/shadcn/SKILL.md', copilotAdapter, 'user-invocable: false');
    for (const asset of ['shadcn-small.png', 'shadcn.png']) {
      if (!await exists(`.agents/skills/shadcn/assets/${asset}`)) {
        errors.push(`Missing shadcn OpenAI asset: ${asset}`);
      }
    }
  }
}

async function checkSkillDirectories() {
  for (const base of ['.agents/skills', '.claude/skills', '.github/skills']) {
    let entries = [];
    try {
      entries = await fs.readdir(path.join(root, base), { withFileTypes: true });
    } catch {
      errors.push(`Missing directory: ${base}`);
      continue;
    }
    const actual = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (actual.join(',') !== skills.join(',')) {
      errors.push(`${base} must contain exactly: ${skills.join(', ')}`);
    }
  }
}

async function checkReviewers() {
  const reviewers = [
    '.claude/agents/code-review.md',
    '.github/agents/code-review.agent.md',
    '.codex/agents/code-review.toml',
  ];
  for (const reviewerPath of reviewers) {
    const reviewer = await read(reviewerPath);
    requireText(reviewerPath, reviewer, '.agents/skills/code-review/SKILL.md');
    requireText(reviewerPath, reviewer, 'Do not edit files');
  }

  const claudeReviewer = await read(reviewers[0]);
  requireText(reviewers[0], claudeReviewer, 'permissionMode: dontAsk');

  const codexReviewer = await read(reviewers[2]);
  requireText(reviewers[2], codexReviewer, 'sandbox_mode = "read-only"');

  const codexConfig = await read('.codex/config.toml');
  requireText('.codex/config.toml', codexConfig, '[agents]');
  requireText('.codex/config.toml', codexConfig, 'enabled = true');
}

async function checkEntrypoints() {
  const claude = await read('CLAUDE.md');
  if (claude.trim() !== '@AGENTS.md') {
    errors.push('CLAUDE.md must only import @AGENTS.md');
  }
  if (await exists('.github/copilot-instructions.md')) {
    errors.push('.github/copilot-instructions.md duplicates AGENTS.md and must not exist');
  }

  const agents = await read('AGENTS.md');
  requireText('AGENTS.md', agents, 'Canonical Agent Skills live in `.agents/skills/`');
  requireText('AGENTS.md', agents, '`/<skill-name>` in Claude Code or Copilot');
  requireText('AGENTS.md', agents, '`$<skill-name>` in Codex');
}

await checkSkillDirectories();
await Promise.all(skills.map(checkSkill));
await checkReviewers();
await checkEntrypoints();

if (errors.length > 0) {
  console.error('Agent configuration check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Agent configuration is consistent across ${skills.length} skills.`);

/**
 * skill-creator — VFS scaffolding for new Skills following agentskills.io spec.
 *
 * Creates a new skill directory with a SKILL.md template, plus empty `scripts/`
 * and `references/` subdirs. Naming collides are resolved by appending `-N`.
 */
import { vfs } from '@/lib/vfs';
import { t } from '@/lib/i18n';

async function uniqueName(dir: string, base: string): Promise<string> {
  if (!(await vfs.exists(`${dir}/${base}`))) return base;
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = `${base}-${n}`;
    if (!(await vfs.exists(`${dir}/${candidate}`))) return candidate;
    n++;
  }
}

export interface CreatedSkill {
  /** Absolute path to the new skill directory. */
  dirPath: string;
  /** Absolute path to the SKILL.md entry file (good target for auto-select). */
  entryFile: string;
}

/**
 * Scaffold a new skill under `root` and return its paths. The caller is
 * expected to refresh the file tree and optionally select `entryFile`.
 */
export async function createSkillTemplate(root: string): Promise<CreatedSkill> {
  const name = await uniqueName(root, 'new-skill');
  const dirPath = `${root}/${name}`;
  const entryFile = `${dirPath}/SKILL.md`;

  const skillMd = `---
name: ${name}
description: "TODO - describe what this skill does and when to use it."
metadata:
  matched-url:
    - "*"
  author: ""
  version: "1.0"
---

## Instructions

${t('settings.skills.newBody')}
`;

  await vfs.mkdir(dirPath, { recursive: true });
  await vfs.mkdir(`${dirPath}/scripts`, { recursive: true });
  await vfs.mkdir(`${dirPath}/references`, { recursive: true });
  await vfs.writeFile(entryFile, skillMd);

  return { dirPath, entryFile };
}

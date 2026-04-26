/**
 * Skill permission grants — storage layer for the "always allow" decisions
 * the user makes when a skill script first requests chrome.* permissions.
 *
 * Lives outside `lib/tools/run-skill.ts` so non-tool code (e.g. the
 * import/export flow under `lib/ai-config/skill-transfer.ts`) can revoke
 * a stale grant when a skill's contents are replaced, without pulling
 * in the agent-tool runtime.
 *
 * Backed by `chrome.storage.local[GRANTS_KEY]`. The key and shape are kept
 * stable for backward compatibility with existing user installs.
 */

const GRANTS_KEY = 'skillGrants';

export interface SkillPermissionGrant {
  granted: 'always';
  permissions: string[];
  grantedAt: number;
}

export type SkillGrants = Record<string, SkillPermissionGrant>;

/** Read the entire grants map from storage. Returns `{}` if unset. */
export async function getSkillGrants(): Promise<SkillGrants> {
  const result = await chrome.storage.local.get(GRANTS_KEY);
  return (result[GRANTS_KEY] as SkillGrants) ?? {};
}

/** Read a single grant by skill name, or `undefined` if not granted. */
export async function getSkillGrant(skillName: string): Promise<SkillPermissionGrant | undefined> {
  const grants = await getSkillGrants();
  return grants[skillName];
}

/** Persist an "always allow" grant for the given skill + permission set. */
export async function setSkillGrant(skillName: string, permissions: string[]): Promise<void> {
  const grants = await getSkillGrants();
  grants[skillName] = { granted: 'always', permissions, grantedAt: Date.now() };
  await chrome.storage.local.set({ [GRANTS_KEY]: grants });
}

/**
 * Remove the grant for a skill, if any. Safe to call when none exists —
 * no-ops in that case. Use after replacing a skill's contents (e.g.
 * import-overwrite) so the new code can't inherit stale trust.
 */
export async function clearSkillGrant(skillName: string): Promise<void> {
  const grants = await getSkillGrants();
  if (!(skillName in grants)) return;
  delete grants[skillName];
  await chrome.storage.local.set({ [GRANTS_KEY]: grants });
}

/**
 * Order-insensitive equality check for permission lists. Used to detect
 * when a skill's declared permissions have changed since the user last
 * granted, in which case the existing grant must NOT auto-apply.
 */
export function permissionsMatch(stored: string[], current: string[]): boolean {
  if (stored.length !== current.length) return false;
  const sorted1 = [...stored].sort();
  const sorted2 = [...current].sort();
  return sorted1.every((v, i) => v === sorted2[i]);
}

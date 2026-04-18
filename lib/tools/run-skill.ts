import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_RUN_SKILL } from '@/lib/types';
import { CEBIAN_SKILLS_DIR, SKILL_ENTRY_FILE } from '@/lib/constants';
import { vfs, normalizePath } from '@/lib/vfs';
import { parseFrontmatter } from '@/lib/ai-config/frontmatter';
import { runInSandbox } from './sandbox-rpc';

// ─── Permission grant storage ───

interface SkillPermissionGrant {
  granted: 'always';
  permissions: string[];
  grantedAt: number;
}

type SkillGrants = Record<string, SkillPermissionGrant>;

const GRANTS_KEY = 'skillGrants';

/** Nonces for permission confirmation — prevents the agent from bypassing ask_user */
const pendingNonces = new Map<string, { skill: string; permissions: string[]; expiresAt: number }>();
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getGrants(): Promise<SkillGrants> {
  const result = await chrome.storage.local.get(GRANTS_KEY);
  return (result[GRANTS_KEY] as SkillGrants) ?? {};
}

async function setGrant(skillName: string, permissions: string[]): Promise<void> {
  const grants = await getGrants();
  grants[skillName] = { granted: 'always', permissions, grantedAt: Date.now() };
  await chrome.storage.local.set({ [GRANTS_KEY]: grants });
}

function permissionsMatch(stored: string[], current: string[]): boolean {
  if (stored.length !== current.length) return false;
  const sorted1 = [...stored].sort();
  const sorted2 = [...current].sort();
  return sorted1.every((v, i) => v === sorted2[i]);
}

// ─── Tool definition ───

const RunSkillParameters = Type.Object({
  skill: Type.String({
    description: 'Skill folder name (e.g. "web-summary"). Must match a directory under ~/.cebian/skills/.',
  }),
  script: Type.String({
    description: 'Relative path to JS file within the skill directory (e.g. "scripts/extract.js").',
  }),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
    description: 'Arguments passed to the script, accessible via the `args` variable.',
  })),
  tabId: Type.Optional(Type.Number({
    description: 'Tab ID for page.executeJs context. Omit to use the active tab. Get tab IDs from the context block.',
  })),
  confirmation_nonce: Type.Optional(Type.String({
    description: 'Nonce returned by a previous permission_required response. Include after user confirms via ask_user.',
  })),
  always_allow: Type.Optional(Type.Boolean({
    description: 'Set to true when the user chose "always allow" for this skill. Only effective with a valid confirmation_nonce.',
  })),
});

export const runSkillTool: AgentTool<typeof RunSkillParameters> = {
  name: TOOL_RUN_SKILL,
  label: 'Run Skill',
  description:
    'Execute a JavaScript file from a skill\'s scripts/ directory in a sandboxed environment. ' +
    'The script runs with chrome.* APIs as declared in the skill\'s metadata.permissions. ' +
    'If the skill declares no permissions, only basic JS APIs (fetch, JSON, crypto, etc.) are available. ' +
    'If the skill declares "page.executeJs" permission, an executeInPage(code) async function is available ' +
    'to run JavaScript in a browser tab via CDP and return the result. ' +
    'The script runs as a complete JavaScript file — use `module.exports = value` to set the return value. ' +
    'Arguments are accessible via the `args` variable. Returns JSON-serialized result.\n\n' +
    'PERMISSION FLOW: On first call, if the skill has not been granted permission, ' +
    'the tool returns a permission prompt with a confirmation_nonce. You must then use ask_user to show the prompt ' +
    'to the user with three options matching the user\'s language ' +
    '(equivalents of: Deny / Allow once / Always allow this skill). ' +
    'If the user approves, call this tool again with the same parameters plus the confirmation_nonce. ' +
    'If they chose the "always allow" option, also set always_allow=true. If the user denies, do not call this tool again.',
  parameters: RunSkillParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();

    const { skill, script, args = {}, tabId, confirmation_nonce, always_allow = false } = params;

    // ─── Path traversal protection ───

    const normalizedSkillsRoot = normalizePath(CEBIAN_SKILLS_DIR);
    const normalizedSkillDir = normalizePath(`${CEBIAN_SKILLS_DIR}/${skill}`);
    if (!normalizedSkillDir.startsWith(normalizedSkillsRoot + '/')) {
      return {
        content: [{ type: 'text', text: 'Error: invalid skill name — path traversal detected.' }],
        details: { status: 'error' },
      };
    }
    const normalizedScriptPath = normalizePath(`${normalizedSkillDir}/${script}`);
    if (!normalizedScriptPath.startsWith(normalizedSkillDir + '/')) {
      return {
        content: [{ type: 'text', text: 'Error: script path escapes skill directory.' }],
        details: { status: 'error' },
      };
    }

    // ─── ① Read SKILL.md and parse permissions ───

    const skillMdPath = `${normalizedSkillDir}/${SKILL_ENTRY_FILE}`;

    try {
      if (!(await vfs.exists(skillMdPath))) {
        return {
          content: [{ type: 'text', text: `Error: skill "${skill}" not found. No SKILL.md at ${skillMdPath}` }],
          details: { status: 'error' },
        };
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error reading skill: ${(err as Error).message}` }],
        details: { status: 'error' },
      };
    }

    let permissions: string[] = [];
    try {
      const raw = await vfs.readFile(skillMdPath, 'utf8');
      const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      const { data } = parseFrontmatter(content);
      if (data.metadata && typeof data.metadata === 'object') {
        const meta = data.metadata as Record<string, unknown>;
        if (Array.isArray(meta.permissions)) {
          permissions = meta.permissions.filter((p): p is string => typeof p === 'string');
        }
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error parsing SKILL.md: ${(err as Error).message}` }],
        details: { status: 'error' },
      };
    }

    // ─── ② Read script file ───

    let code: string;
    try {
      if (!(await vfs.exists(normalizedScriptPath))) {
        return {
          content: [{ type: 'text', text: `Error: script not found: ${normalizedScriptPath}` }],
          details: { status: 'error' },
        };
      }
      const raw = await vfs.readFile(normalizedScriptPath, 'utf8');
      code = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error reading script: ${(err as Error).message}` }],
        details: { status: 'error' },
      };
    }

    // ─── ③ Check permission grant ───

    if (permissions.length > 0) {
      const grants = await getGrants();
      const grant = grants[skill];
      const isGranted = grant?.granted === 'always' && permissionsMatch(grant.permissions, permissions);

      if (!isGranted) {
        // Check if a valid nonce was provided (proves user confirmed via ask_user)
        if (confirmation_nonce) {
          const nonceData = pendingNonces.get(confirmation_nonce);
          pendingNonces.delete(confirmation_nonce);
          if (!nonceData || nonceData.skill !== skill || nonceData.expiresAt < Date.now()) {
            return {
              content: [{ type: 'text', text: 'Error: invalid or expired confirmation nonce. Please retry the permission flow.' }],
              details: { status: 'error' },
            };
          }
          // Valid nonce — grant permission
          if (always_allow) {
            await setGrant(skill, permissions);
          }
        } else {
          // Generate nonce and return permission prompt
          const nonce = crypto.randomUUID();
          pendingNonces.set(nonce, { skill, permissions, expiresAt: Date.now() + NONCE_TTL_MS });
          const permList = permissions.map((p) => `  • ${p}`).join('\n');
          return {
            content: [{
              type: 'text',
              text: `Permission required to execute skill code.\n\n` +
                `Skill: ${skill}\n` +
                `Script: ${script}\n` +
                `Requested permissions:\n${permList}\n\n` +
                `confirmation_nonce: ${nonce}\n\n` +
                `Use ask_user to ask the user for confirmation with three options in the user's language ` +
                `(equivalents of: Deny / Allow once / Always allow this skill). ` +
                `If approved, call run_skill again with the same skill/script/args plus confirmation_nonce="${nonce}". ` +
                `If "always allow", also set always_allow=true. If denied, do not call again.`,
            }],
            details: { status: 'permission_required' },
          };
        }
      }
    }

    signal?.throwIfAborted();

    // ─── ④ Execute in sandbox ───

    try {
      const result = await runInSandbox(code, args as Record<string, unknown>, permissions, tabId);
      const serialized = result !== undefined ? JSON.stringify(result, null, 2) : '(no return value)';

      return {
        content: [{ type: 'text', text: serialized }],
        details: { status: 'done' },
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Script execution error: ${(err as Error).message}` }],
        details: { status: 'error' },
      };
    }
  },
};

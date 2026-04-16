import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_EXECUTE_SKILL_CODE } from '@/lib/types';
import { CEBIAN_SKILLS_DIR, SKILL_ENTRY_FILE } from '@/lib/constants';
import { vfs, normalizePath } from '@/lib/vfs';
import { parseFrontmatter } from '@/lib/ai-config/frontmatter';
import { resolveTabId, executeViaDebugger } from './chrome-api';

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

// ─── Sandbox construction ───

const BASE_SANDBOX_KEYS = [
  'fetch', 'JSON', 'console', 'crypto',
  'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams',
  'atob', 'btoa', 'setTimeout', 'clearTimeout', 'AbortController',
  'args',
];

function buildSandbox(permissions: string[], args: Record<string, unknown>, tabId?: number): { keys: string[]; values: unknown[] } {
  const keys = [...BASE_SANDBOX_KEYS];
  const values: unknown[] = [
    fetch, JSON, console, crypto,
    TextEncoder, TextDecoder, URL, URLSearchParams,
    atob, btoa, setTimeout, clearTimeout, AbortController,
    args,
  ];

  // Build a scoped chrome object with only declared namespaces
  const chromePerms = permissions.filter((p) => p.startsWith('chrome.'));
  if (chromePerms.length > 0) {
    const chromeSubset: Record<string, unknown> = {};
    for (const perm of chromePerms) {
      const ns = perm.replace(/^chrome\./, '');
      if (ns && (chrome as any)[ns]) {
        chromeSubset[ns] = (chrome as any)[ns];
      }
    }
    if (Object.keys(chromeSubset).length > 0) {
      keys.push('chrome');
      values.push(chromeSubset);
    }
  }

  // Inject executeInPage if page.executeJs permission is declared
  if (permissions.includes('page.executeJs')) {
    keys.push('executeInPage');
    values.push(async (code: string): Promise<string> => {
      const resolved = await resolveTabId(tabId);
      return executeViaDebugger(resolved, code);
    });
  }

  return { keys, values };
}

// ─── Tool definition ───

const ExecuteSkillCodeParameters = Type.Object({
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

export const executeSkillCodeTool: AgentTool<typeof ExecuteSkillCodeParameters> = {
  name: TOOL_EXECUTE_SKILL_CODE,
  label: 'Execute Skill Code',
  description:
    'Execute a JavaScript file from a skill\'s scripts/ directory in the extension background context. ' +
    'The script runs with chrome.* APIs as declared in the skill\'s metadata.permissions. ' +
    'If the skill declares no permissions, only basic JS APIs (fetch, JSON, crypto, etc.) are available. ' +
    'If the skill declares "page.executeJs" permission, an executeInPage(code) async function is available ' +
    'to run JavaScript in a browser tab via CDP and return the result. ' +
    'The script body runs as an async function — use `return` to produce a result. ' +
    'Arguments are accessible via the `args` variable. Returns JSON-serialized result.\n\n' +
    'PERMISSION FLOW: On first call, if the skill has not been granted permission, ' +
    'the tool returns a permission prompt with a confirmation_nonce. You must then use ask_user to show the prompt ' +
    'to the user with options: "拒绝", "本次允许", "始终允许此技能". ' +
    'If the user approves, call this tool again with the same parameters plus the confirmation_nonce. ' +
    'If "always allow", also set always_allow=true. If the user denies, do not call this tool again.',
  parameters: ExecuteSkillCodeParameters,

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
                `Use ask_user to ask the user for confirmation with options: "拒绝", "本次允许", "始终允许此技能". ` +
                `If approved, call execute_skill_code again with the same skill/script/args plus confirmation_nonce="${nonce}". ` +
                `If "always allow", also set always_allow=true. If denied, do not call again.`,
            }],
            details: { status: 'permission_required' },
          };
        }
      }
    }

    signal?.throwIfAborted();

    // ─── ④ Build sandbox and execute ───
    // TODO: new Function() may be blocked by MV3 CSP in background SW.
    // Fallback: execute in a sandboxed page via postMessage.

    try {
      const { keys, values } = buildSandbox(permissions, args as Record<string, unknown>, tabId);
      const fn = new Function(...keys, `return (async () => { ${code} })()`);
      const result = await fn(...values);
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

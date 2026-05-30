import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_RUN_SKILL } from '@/lib/types';
import { CEBIAN_SKILLS_DIR, SKILL_ENTRY_FILE } from '@/lib/constants';
import { vfs, normalizePath } from '@/lib/vfs';
import { parseFrontmatter } from '@/lib/frontmatter';
import { getSkillGrants, setSkillGrant, permissionsMatch } from '@/lib/ai-config/skill-grants';
import { runInSandbox } from './sandbox-rpc';

// ─── Permission confirmation nonces ───

/** Nonces for permission confirmation — prevents the agent from bypassing ask_user */
const pendingNonces = new Map<string, { skill: string; permissions: string[]; expiresAt: number }>();
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
  tabId: Type.Number({
    description: 'Required. Tab ID for the executeInPage helper. If the skill does not declare "page.executeJs", this is ignored. Read it from the `tabId:` line under `[Active Tab]` (or the windows list) in the context block.',
  }),
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
    'If the skill declares "vfs.read" or "vfs.write", a `vfs` global is available with readFile/writeFile/mkdir/readdir/stat/exists/unlink methods. ' +
    'All vfs paths are relative to the skill\'s session workspace (`/workspaces/<sessionId>/<skillName>/`); the absolute root is also exposed as the read-only `vfs.cwd` string for constructing markdown links like `![file](#${vfs.cwd}/out.png)`. ' +
    '`vfs.write` automatically grants read-class methods too (stat / readFile / readdir / exists) — declaring only `vfs.write` is enough for skills that both produce and inspect their own output. ' +
    'NOTE: `vfs.stat` returns `{size, mtimeMs, isFile, isDirectory}` where `isFile`/`isDirectory` are booleans (not methods, unlike Node fs.Stats). Blobs/Files cannot cross the RPC boundary — convert with `new Uint8Array(await blob.arrayBuffer())` before passing to `vfs.writeFile`. ' +
    'If the skill declares "bgFetch" (or `bgFetch:<match-pattern>`), a `bgFetch(url, init?)` global is available with the same shape as native `fetch`. Requests run in the background SW with the extension\'s host_permissions, bypassing CORS. The response object has `.status` / `.ok` / `.headers` (Headers instance) / `.text()` / `.json()` / `.arrayBuffer()` / `.bytes()` / `.blob()` — same surface as native Response. Patterns use Chrome match-pattern syntax: bare `bgFetch` allows any http(s) URL (= `*://*/*`); `bgFetch:https://api.example.com/*` scopes to one host. ' +
    'The script runs as a complete JavaScript file — use `module.exports = value` to set the return value. ' +
    'Arguments are accessible via the `args` variable. Returns JSON-serialized result.\n\n' +
    'PERMISSION FLOW: On first call, if the skill has not been granted permission, ' +
    'the tool returns a permission prompt with a confirmation_nonce. You must then use ask_user to show the prompt ' +
    'to the user with three options matching the user\'s language ' +
    '(equivalents of: Deny / Allow once / Always allow this skill). ' +
    'If the user approves, call this tool again with the same parameters plus the confirmation_nonce. ' +
    'If they chose the "always allow" option, also set always_allow=true. If the user denies, do not call this tool again.',
  parameters: RunSkillParameters,

  async execute(): Promise<AgentToolResult<{}>> {
    // run-skill 必须通过 createSessionRunSkillTool(sessionId) 拿到 session 绑定
    // 的实例 —— 这个共享单例只用来填 tool registry / schema 引用，不应被实际调用。
    throw new Error(
      'runSkillTool placeholder invoked. Build the per-session instance via createSessionRunSkillTool(sessionId).',
    );
  },
};

/**
 * Build a session-bound run_skill tool. The closure captures `sessionId`
 * so that sandbox scripts can have their vfs writes routed to the
 * session's workspace (`/workspaces/<sessionId>/<skill>/`).
 *
 * 工厂模式跟 `createSessionAskUserTool` 同款 —— 每个 session 有独立实例，
 * 但 description / parameters / name 完全复用上面的共享定义，避免漂移。
 */
export function createSessionRunSkillTool(sessionId: string): AgentTool<typeof RunSkillParameters> {
  return {
    ...runSkillTool,
    execute: (_toolCallId, params, signal) => executeRunSkill(sessionId, params, signal),
  };
}

async function executeRunSkill(
  sessionId: string,
  params: Static<typeof RunSkillParameters>,
  signal?: AbortSignal,
): Promise<AgentToolResult<{}>> {
  signal?.throwIfAborted();

  const { skill, script, args = {}, tabId, confirmation_nonce, always_allow = false } = params;

  // ─── Path traversal protection ───

  const normalizedSkillsRoot = normalizePath(CEBIAN_SKILLS_DIR);
  const normalizedSkillDir = normalizePath(`${CEBIAN_SKILLS_DIR}/${skill}`);
  if (!normalizedSkillDir.startsWith(normalizedSkillsRoot + '/')) {
    throw new Error('Invalid skill name — path traversal detected.');
  }
  const normalizedScriptPath = normalizePath(`${normalizedSkillDir}/${script}`);
  if (!normalizedScriptPath.startsWith(normalizedSkillDir + '/')) {
    throw new Error('Script path escapes skill directory.');
  }

  // ─── ① Read SKILL.md and parse permissions ───

  const skillMdPath = `${normalizedSkillDir}/${SKILL_ENTRY_FILE}`;

  if (!(await vfs.exists(skillMdPath))) {
    throw new Error(`Skill "${skill}" not found. No SKILL.md at ${skillMdPath}`);
  }

  let permissions: string[] = [];
  const raw = await vfs.readFile(skillMdPath, 'utf8');
  const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
  try {
    const { data } = parseFrontmatter(content);
    if (data.metadata && typeof data.metadata === 'object') {
      const meta = data.metadata as Record<string, unknown>;
      if (Array.isArray(meta.permissions)) {
        permissions = meta.permissions.filter((p): p is string => typeof p === 'string');
      }
    }
  } catch (err) {
    throw new Error(`Failed to parse SKILL.md: ${(err as Error).message}`);
  }

  // ─── ② Read script file ───

  if (!(await vfs.exists(normalizedScriptPath))) {
    throw new Error(`Script not found: ${normalizedScriptPath}`);
  }
  const rawScript = await vfs.readFile(normalizedScriptPath, 'utf8');
  const code = typeof rawScript === 'string' ? rawScript : new TextDecoder().decode(rawScript as Uint8Array);

  // ─── ③ Check permission grant ───

  if (permissions.length > 0) {
    const grants = await getSkillGrants();
    const grant = grants[skill];
    const isGranted = grant?.granted === 'always' && permissionsMatch(grant.permissions, permissions);

    if (!isGranted) {
      // 已经带了 nonce —— 校验是不是用户确认过的那次
      if (confirmation_nonce) {
        const nonceData = pendingNonces.get(confirmation_nonce);
        pendingNonces.delete(confirmation_nonce);
        if (!nonceData || nonceData.skill !== skill || nonceData.expiresAt < Date.now()) {
          throw new Error('Invalid or expired confirmation nonce. Please retry the permission flow.');
        }
        // 合法 nonce —— 持久化授权
        if (always_allow) {
          await setSkillGrant(skill, permissions);
        }
      } else {
        // 没 nonce —— 生成一个并返回 permission prompt。这是正常的 next-step
        // 返回，不是错误：agent 读到内容会去调 ask_user 然后再来一次。
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
          details: {},
        };
      }
    }
  }

  signal?.throwIfAborted();

  // ─── ④ Execute in sandbox ───

  const result = await runInSandbox(code, args as Record<string, unknown>, permissions, skill, sessionId, tabId);
  const serialized = result !== undefined ? JSON.stringify(result, null, 2) : '(no return value)';

  return {
    content: [{ type: 'text', text: serialized }],
    details: {},
  };
}

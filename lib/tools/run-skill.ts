import { Type, type Static } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_RUN_SKILL } from '@/lib/tools/names';
import { CEBIAN_SKILLS_DIR, SKILL_ENTRY_FILE } from '@/lib/constants';
import { vfs, normalizePath } from '@/lib/vfs';
import { parseFrontmatter } from '@/lib/frontmatter';
import { getSkillGrants, setSkillGrant, permissionsMatch } from '@/lib/ai-config/skill-grants';
import { validateSkillName } from '@/lib/ai-config/skill-validator';
import { t } from '@/lib/i18n';
import type { ToolGate, PermissionRequestDetails } from '@/lib/tool-permissions';
import { runInSandbox } from './sandbox-rpc';

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
    'PERMISSION: If the skill declares metadata.permissions and has not been granted, the user is asked to ' +
    'authorize before the script runs — this happens automatically, you do not manage it. A blocked call ' +
    'returns an error result saying the user denied permission; in that case do not retry the same call.',
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

  const { skill, script, args = {}, tabId } = params;

  // 授权已由 beforeToolCall 门禁（runSkillGate）在执行前强制：execute 能跑到这里，
  // 即代表「该 skill 无需授权」或「用户已授权」。这里只解析路径 + 进沙箱执行。
  const { permissions, code } = await resolveSkillRun(skill, script);

  signal?.throwIfAborted();

  const result = await runInSandbox(code, args as Record<string, unknown>, permissions, skill, sessionId, tabId);
  const serialized = result !== undefined ? JSON.stringify(result, null, 2) : '(no return value)';

  return {
    content: [{ type: 'text', text: serialized }],
    details: {},
  };
}

// ─── Skill resolution (shared by execute + gate) ───

/**
 * 解析 skill 目录、校验路径安全、读 SKILL.md 并解析声明的 `metadata.permissions`。
 * 被 `runSkillGate`（只要 permissions）与 `resolveSkillRun`（再读脚本）复用。
 * 任何一步失败都 throw —— 调用方据场景决定是抛给 LLM 还是 fail-open。
 */
async function resolveSkillPermissions(
  skill: string,
): Promise<{ normalizedSkillDir: string; permissions: string[] }> {
  // 技能身份 = 文件夹名（全代码库一致：grants / 扫描 / 导入清理都用它）。先按
  // agentskills.io 规范校验，拒掉 `foo/../bar` 这类别名——它们能指向同一目录却
  // 让 grant 的存/读/清用上不同 key，制造授权错配（详见 skill-validator）。
  const nameCheck = validateSkillName(skill);
  if (!nameCheck.valid) {
    throw new Error(`Invalid skill name "${skill}": ${nameCheck.error}`);
  }

  const normalizedSkillsRoot = normalizePath(CEBIAN_SKILLS_DIR);
  const normalizedSkillDir = normalizePath(`${CEBIAN_SKILLS_DIR}/${skill}`);
  // 防御性兜底：规范名已排除路径分隔符，这层 containment 检查理论上不会触发。
  if (!normalizedSkillDir.startsWith(normalizedSkillsRoot + '/')) {
    throw new Error('Invalid skill name — path traversal detected.');
  }

  const skillMdPath = `${normalizedSkillDir}/${SKILL_ENTRY_FILE}`;
  if (!(await vfs.exists(skillMdPath))) {
    throw new Error(`Skill "${skill}" not found. No SKILL.md at ${skillMdPath}`);
  }

  const raw = await vfs.readFile(skillMdPath, 'utf8');
  const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
  let permissions: string[] = [];
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

  return { normalizedSkillDir, permissions };
}

/**
 * execute 专用：在 `resolveSkillPermissions` 之上再校验脚本路径不逃逸出 skill 目录、
 * 读出脚本源码。返回执行所需的 `permissions` + `code`。
 */
async function resolveSkillRun(
  skill: string,
  script: string,
): Promise<{ permissions: string[]; code: string }> {
  const { normalizedSkillDir, permissions } = await resolveSkillPermissions(skill);

  const normalizedScriptPath = normalizePath(`${normalizedSkillDir}/${script}`);
  if (!normalizedScriptPath.startsWith(normalizedSkillDir + '/')) {
    throw new Error('Script path escapes skill directory.');
  }
  if (!(await vfs.exists(normalizedScriptPath))) {
    throw new Error(`Script not found: ${normalizedScriptPath}`);
  }
  const rawScript = await vfs.readFile(normalizedScriptPath, 'utf8');
  const code = typeof rawScript === 'string' ? rawScript : new TextDecoder().decode(rawScript as Uint8Array);

  return { permissions, code };
}

// ─── Permission gate (registered into agent-manager's PERMISSION_GATES) ───

/**
 * run_skill 的执行前授权策略。由通用门禁在 `beforeToolCall` 调用——
 * - `check`：解析声明的 permissions；无声明或已 `always` 授权且权限集匹配 → 放行；
 *   否则要求授权，request 携带成句标题 + 原始权限 token（UI 经 describePermission 渲染）。
 * - `persistGrant`：用户选「始终允许」时落 `skillGrants`，best-effort（失败降级为仅本次）。
 *
 * 解析失败（skill 不存在 / SKILL.md 损坏 / 路径穿越）在 `check` 里一律 fail-open 到
 * `execute()`：那时尚无脚本执行，execute 会再解析并抛出权威错误给 LLM，无安全风险。
 */
export const runSkillGate: ToolGate = {
  toolName: TOOL_RUN_SKILL,

  async check(args): Promise<{ needsGrant: boolean; request?: PermissionRequestDetails }> {
    const { skill, script } = args as Static<typeof RunSkillParameters>;

    let permissions: string[];
    try {
      ({ permissions } = await resolveSkillPermissions(skill));
    } catch {
      // 解析失败 → 交给 execute 抛权威错误
      return { needsGrant: false };
    }

    if (permissions.length === 0) return { needsGrant: false };

    const grants = await getSkillGrants();
    const grant = grants[skill];
    if (grant?.granted === 'always' && permissionsMatch(grant.permissions, permissions)) {
      return { needsGrant: false };
    }

    return {
      needsGrant: true,
      request: {
        title: t('chat.permission.title', [skill, script]),
        permissions,
      },
    };
  },

  async persistGrant(args): Promise<void> {
    const { skill } = args as Static<typeof RunSkillParameters>;
    try {
      const { permissions } = await resolveSkillPermissions(skill);
      await setSkillGrant(skill, permissions);
    } catch (err) {
      // 持久化失败不阻断本次已授权的执行——降级为「仅本次」。
      console.warn('[run-skill] failed to persist skill grant:', err);
    }
  },
};

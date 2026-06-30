// 整理结果提交前的「机器校验」——纯函数，守记忆文件格式不变量。光靠 prompt 不够：一次坏
// 整理可能改坏 user_profile.md 的固定 description、造出第二个 user 档、混 topic、写坏
// frontmatter，而索引扫描是宽容的，这些会静默劣化召回。校验不过 → 拒绝提交、丢弃本次整理。

import { parseFrontmatter } from '@/lib/content/frontmatter';
import { USER_PROFILE_FILE, USER_PROFILE_DESCRIPTION, parseMemoryType } from './types';

/** 待校验的一条整理结果文件：顶层文件名（含 .md）+ 全文。 */
export interface OrganizedFile {
  name: string;
  content: string;
}

/** 校验结果：通过，或带一句可读原因的拒绝（原因仅用于日志/诊断，不展示给用户）。 */
export type ValidateResult = { ok: true } | { ok: false; reason: string };

/**
 * 校验整理结果是否守住不变量：
 * - 只顶层 `.md`（无子路径分隔符）。
 * - frontmatter `type` 合法（∈ 四类）。
 * - 至多一个 `user` 档；该档必须叫 user_profile.md。
 * - user_profile.md 必须是 `user` 类，且 description 恰为固定标签 USER_PROFILE_DESCRIPTION。
 * 任一违反 → 返回 { ok:false, reason }，编排层据此拒绝提交。
 */
export function validateOrganized(files: OrganizedFile[]): ValidateResult {
  let userCount = 0;

  for (const f of files) {
    if (f.name.includes('/') || !f.name.endsWith('.md')) {
      return { ok: false, reason: `non-top-level or non-.md file: ${f.name}` };
    }

    let data: Record<string, unknown>;
    try {
      ({ data } = parseFrontmatter(f.content));
    } catch {
      // 整理 agent 写坏了 YAML frontmatter → 拒绝提交（守住 ValidateResult 契约，不外抛）。
      return { ok: false, reason: `invalid frontmatter: ${f.name}` };
    }
    const type = parseMemoryType(data.type);
    if (!type) {
      return { ok: false, reason: `missing or invalid type: ${f.name}` };
    }

    const isProfileName = f.name === USER_PROFILE_FILE;
    if (type === 'user') {
      userCount++;
      if (!isProfileName) {
        return { ok: false, reason: `user-type file must be ${USER_PROFILE_FILE}, got ${f.name}` };
      }
      // 严格逐字比对（不 trim）：固定标签的不变量就是「恰为此值」，多余空白也算违规。
      if (data.description !== USER_PROFILE_DESCRIPTION) {
        return {
          ok: false,
          reason: `${USER_PROFILE_FILE} description must be exactly "${USER_PROFILE_DESCRIPTION}"`,
        };
      }
    } else if (isProfileName) {
      // user_profile.md 反过来也必须是 user 类。
      return { ok: false, reason: `${USER_PROFILE_FILE} must be type user, got ${type}` };
    }
  }

  if (userCount > 1) {
    return { ok: false, reason: `at most one user-type memory allowed, found ${userCount}` };
  }
  return { ok: true };
}

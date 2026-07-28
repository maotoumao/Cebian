// 组装喂给 agent 的两类文本输入：会话的 systemPrompt（base + skills + 用户指令），
// 以及每轮的结构化 user 消息（附件前缀 + 页面上下文 + 记忆 + 用户原文）。
//
// 分两层，同处本文件让分层在视觉上相邻：
//   build*   —— 给定零件拼字符串，纯同步，不认识 session / VFS / scanner；
//   compose* —— 先读 async 上下文（存储 / skills 扫描 / 页面状态），再委托 build*。
//
// 造 Agent 实例本身在同目录的 `factory.ts` —— 它只接收本文件产出的成形字符串。

import { userInstructions as userInstructionsStorage, memorySettings } from '@/lib/persistence/storage';
import { DEFAULT_SYSTEM_PROMPT } from './system-prompt';
import { gatherPageContext } from './page-context';
import { buildTextPrefix, type Attachment } from '@/lib/agent/attachments';
import { scanSkillIndex, buildSkillsBlock } from '@/lib/ai-config/scanner';
import { MEMORY_INSTRUCTIONS, memoryLimitationLine } from '@/lib/memory/prompt';
import { scanMemoryIndex, buildMemoriesBlock, buildUserProfileBlock } from '@/lib/memory/index-scan';

// ─── build 层（纯拼接） ───

/**
 * 构造 agent 的 systemPrompt：基础提示词（按 `variables` 替换其中的 `{{KEY}}`
 * 占位符）+ 可选的 `<skills>`（skills 索引）段 + 可选的 `<user-instructions>` 段。
 * 作为 systemPrompt 拼接的单一真理来源，由同文件的 `composeSystemPrompt` 在会话
 * 创建 / 切模型 / retry / 每轮派发前刷新时调用。
 *
 * 保持纯/同步：变量值（如会话工作目录）、skills、instructions 的获取都留在
 * `composeSystemPrompt`；本函数只负责拼接 + 文本替换，不认识具体变量名、不依赖
 * VFS / scanner / session 等概念。
 *
 * skills 块置于 system 顶部（贴近 base prompt），随整个 system 落入缓存前缀——
 * skills 不变则逐字节一致、每轮命中缓存；skills 变则击穿一次（装/卸 skill 的
 * 实时性代价，低频可接受）。system 末尾只有一个缓存断点，skills 与 instructions
 * 谁先谁后不影响命中率，顺序仅取语义可读性。
 */
function buildSystemPrompt(
  userInstructions: string,
  skillsBlock?: string,
  variables: Record<string, string> = {},
): string {
  const basePrompt = DEFAULT_SYSTEM_PROMPT.replace(
    /\{\{(\w+)\}\}/g,
    (match, name: string) => (Object.hasOwn(variables, name) ? variables[name] : match),
  );
  const parts: string[] = [basePrompt];

  const trimmedSkills = skillsBlock?.trim();
  if (trimmedSkills) {
    parts.push(trimmedSkills);
  }

  const trimmedInstructions = userInstructions.trim();
  if (trimmedInstructions) {
    parts.push(`<user-instructions>\n${trimmedInstructions}\n</user-instructions>`);
  }

  return parts.join('\n\n');
}

/**
 * 组装本轮 user 消息里的记忆区：记忆关闭则空串；开启则拼常驻 <user_profile>
 * 全文 + <memories> 索引。两段都可能为空（无 profile / 无其他记忆），由 composeUserMessage 守卫不注入。
 * 每轮调用：scanMemoryIndex 命中缓存、开销≈0；记忆 / 日期不变则逐字节一致（缓存友好）。
 */
async function buildMemoriesContext(memoryEnabled: boolean): Promise<string> {
  if (!memoryEnabled) return '';
  // 常驻 <user_profile> 全文 + <memories> 索引（其余各类）。两段都可能为空，空串过滤。
  const [profile, metas] = await Promise.all([buildUserProfileBlock(), scanMemoryIndex()]);
  return [profile, buildMemoriesBlock(metas)].filter(Boolean).join('\n\n');
}

// ─── compose 层（取数据后委托 build） ───

/**
 * 组装本轮要发给 agent 的「结构化用户消息」：reminder 占位段 + 附件文本前缀 +
 * `<context>`（日期 + 页面上下文）+ `<user-request>`（始终置末）。读 page context
 * 是 async，故本函数 async。
 */
async function composeUserMessage(text: string, attachments: Attachment[], memoryEnabled: boolean): Promise<string> {
  const parts: string[] = [];

  // ① Tool/behavior reminders (placeholder)
  parts.push('<reminder-instructions>\n</reminder-instructions>');

  // ② Attachments (elements + files; images go via multimodal content blocks)
  const attachmentBlock = buildTextPrefix(attachments);
  if (attachmentBlock) parts.push(attachmentBlock);

  // ③ Context: date + page state
  const ctxLines: string[] = [];
  ctxLines.push(`The current date is ${new Date().toLocaleDateString('en-CA')}.`);
  const pageCtx = await gatherPageContext();
  if (pageCtx) {
    ctxLines.push('');
    ctxLines.push(pageCtx);
  }
  parts.push(`<context>\n${ctxLines.join('\n')}\n</context>`);

  // ④ Memories: 记忆开启且非空时注入 <user_profile>常驻 + <memories>索引（数据，权威性低于 Critical Rules）。
  const memoriesBlock = await buildMemoriesContext(memoryEnabled);
  if (memoriesBlock) parts.push(memoriesBlock);

  // ⑤ User request (always last)
  // TODO: user text is NOT sanitized — users are trusted; stripping structural tags would alter their intent.
  parts.push(`<user-request>\n${text.trim()}\n</user-request>`);

  return parts.join('\n\n');
}

/**
 * 组装会话的 systemPrompt——systemPrompt 的单一来源。读取用户指令 + 扫描 skills
 * 索引（命中缓存，开销≈ 0），交给纯函数 `buildSystemPrompt` 拼接。每轮派发前无
 * 条件调用：skills 不变则产出逐字节相同的字符串、命中 system 缓存；skills 变则产
 * 出变化、击穿缓存一次（= 装/卸 skill 的实时性代价）。因此无需写「skills 是否变
 * 化」的 diff 逻辑。
 */
async function composeSystemPrompt(sessionId: string, memoryEnabled?: boolean): Promise<string> {
  const [instructions, skillMetas] = await Promise.all([
    userInstructionsStorage.getValue(),
    scanSkillIndex(),
  ]);
  // memoryEnabled 由调用方传入时复用其快照（让同一轮的 system / user 注入读同一个值）；
  // 未传时（如初始建会话路径）自行读取。
  const enabled = memoryEnabled ?? (await memorySettings.getValue()).enabled;
  const skillsBlock = buildSkillsBlock(skillMetas);
  // 「会话域 → 模板变量」的翻译层：本函数是唯一认识 session 概念、并把它映射成
  // 纯装配器 buildSystemPrompt 所需的 `{{KEY}}` 变量表的地方。新增占位符只改这里。
  // 记忆开启时填入指引段（前后加空行作分隔），关闭时为空串（base 逐字节回到原样）。
  return buildSystemPrompt(instructions || '', skillsBlock, {
    SESSION_ID: sessionId,
    MEMORY_LIMITATION: memoryLimitationLine(enabled),
    MEMORY_SECTION: enabled ? `\n${MEMORY_INSTRUCTIONS}\n` : '',
  });
}

// ─── 公开 API ───

export { composeSystemPrompt, composeUserMessage };

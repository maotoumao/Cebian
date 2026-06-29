import { Agent, type AgentOptions, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import type { Api, Model, Message } from '@earendil-works/pi-ai';
import { providerCredentials, userInstructions as userInstructionsStorage, memorySettings, type OAuthCredential } from '@/lib/persistence/storage';
import { getValidOAuthToken } from '@/lib/providers/oauth';
import { DEFAULT_SYSTEM_PROMPT } from '@/lib/agent/system-prompt';
import { isCompactionSummary } from '@/lib/agent/compaction';
import { gatherPageContext } from '@/lib/agent/page-context';
import { buildTextPrefix, type Attachment } from '@/lib/agent/attachments';
import { scanSkillIndex, buildSkillsBlock } from '@/lib/ai-config/scanner';
import { MEMORY_INSTRUCTIONS, memoryLimitationLine } from '@/lib/memory/prompt';
import { scanMemoryIndex, buildMemoriesBlock, buildUserProfileBlock } from '@/lib/memory/index-scan';

// ─── Provider credential resolution ───

/**
 * 解析某个 provider 的有效 API key：`apiKey` 凭证直接返回；`oauth` 凭证走
 * `getValidOAuthToken`（含自动刷新）。供 agent 的 `getApiKey` 与压缩流程
 * （agent-manager 的独立 `generateSummary` 调用）共用，避免两处复制凭证解析逻辑。
 */
export async function resolveProviderApiKey(
  provider: string,
): Promise<string | undefined> {
  try {
    const creds = await providerCredentials.getValue();
    const cred = creds[provider];
    if (!cred) return undefined;

    if (cred.authType === 'apiKey') {
      return cred.apiKey;
    }

    if (cred.authType === 'oauth') {
      return getValidOAuthToken(provider, cred as OAuthCredential);
    }
  } catch (err) {
    console.error(`[Agent] Failed to get API key for ${provider}:`, err);
  }
  return undefined;
}

// ─── System prompt builder ───

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

// ─── Context composers ───
//
// 「compose 层」：先读 async 上下文（page context / skills / instructions），再组装
// 成发给 agent 的字符串。与纯拼接的 `buildSystemPrompt`（build 层）分工对照——
// build* 给定零件拼字符串、纯同步；compose* 负责取数据再委托 build*。两者同处本文件，
// 让分层在视觉上相邻。

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

/**
 * 组装本轮要发给 agent 的「结构化用户消息」：reminder 占位段 + 附件文本前缀 +
 * `<context>`（日期 + 页面上下文）+ `<user-request>`（始终置末）。读 page context
 * 是 async，故本函数 async。
 */
export async function composeUserMessage(text: string, attachments: Attachment[], memoryEnabled: boolean): Promise<string> {
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
export async function composeSystemPrompt(sessionId: string, memoryEnabled?: boolean): Promise<string> {
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

// ─── Agent factory ───

export interface CreateAgentOptions {
  model: Model<Api>;
  /**
   * 完整成形的 systemPrompt（base + skills + user-instructions 已拼好）。由调用方
   * 经同文件导出的 `composeSystemPrompt`（其内委托纯函数 `buildSystemPrompt`）
   * 组装后传入——本工厂不再自行拼接，避免「先拼一版、马上被含 skills 的版本
   * 覆盖」的双读双设。
   */
  systemPrompt: string;
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high';
  messages?: AgentMessage[];
  /** Session-specific tools array (includes per-session ask_user). */
  tools: AgentTool<any>[];
  /**
   * Optional pre-execution gate. pi-agent-core calls it after a tool's args
   * are validated and before `execute()`; returning `{ block: true, reason }`
   * blocks the call and emits an error tool result. Used to require user
   * authorization before certain tools run (see `lib/agent/tool-permissions.ts`).
   */
  beforeToolCall?: AgentOptions['beforeToolCall'];
}

export function createCebianAgent(options: CreateAgentOptions): Agent {
  const {
    model,
    systemPrompt,
    thinkingLevel,
    messages = [],
    tools: agentTools,
    beforeToolCall,
  } = options;

  const agentOptions: AgentOptions = {
    initialState: {
      systemPrompt,
      model,
      thinkingLevel,
      tools: agentTools,
      messages,
    },

    // 把 AgentMessage 转换为发给 LLM 的 Message。compactionSummary 降级成一条
    // user 消息（用 <summary> 包裹 + 一句「仅供参考、勿直接回应」），其余自定义
    // 类型一律过滤掉，只保留 user / assistant / toolResult。
    convertToLlm: (msgs: AgentMessage[]): Message[] => {
      const out: Message[] = [];
      for (const m of msgs) {
        if (isCompactionSummary(m)) {
          out.push({
            role: 'user',
            content:
              `<summary>\n${m.summary}\n</summary>\n\n` +
              'The block above is a compressed summary of earlier conversation, ' +
              'provided for context only. Do not respond to it directly; ' +
              'continue with the messages that follow.',
            timestamp: m.timestamp,
          });
          continue;
        }
        if (['user', 'assistant', 'toolResult'].includes((m as Message).role)) {
          out.push(m as Message);
        }
      }
      return out;
    },

    // 上下文窗口管理：若存在压缩摘要，则只把「最后一条摘要 + 其后的全部消息」
    // 送给 LLM——摘要之前的历史已被该摘要覆盖，无需再发。state.messages 仍保留
    // 完整历史（无损），此处只是 LLM 边界的视图变换，不写回 state。
    transformContext: async (msgs: AgentMessage[]): Promise<AgentMessage[]> => {
      let lastSummaryIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (isCompactionSummary(msgs[i])) {
          lastSummaryIdx = i;
          break;
        }
      }
      if (lastSummaryIdx < 0) return msgs;
      return msgs.slice(lastSummaryIdx);
    },

    // Dynamic API key resolution (handles OAuth token refresh)
    getApiKey: (provider: string): Promise<string | undefined> =>
      resolveProviderApiKey(provider),

    // 工具执行前授权门禁（可选）。permissionRequest 自定义消息无需在
    // convertToLlm 里特判——上面的 user/assistant/toolResult 白名单已把它
    // 连同其它自定义类型一并过滤，不会发给 provider。
    beforeToolCall,
  };

  return new Agent(agentOptions);
}

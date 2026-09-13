// 会话标题的领域规则：默认标题（首条消息截断）、用户改名 / AI 生成结果的归一化，
// 以及自动生成标题的提示词。全部是纯函数；LLM 调用与落库编排在 background
// （title-generator.ts / session-manager）。

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Message } from '@earendil-works/pi-ai';
import { t } from '@/lib/i18n';
import { oneLine, truncate } from '@/lib/utils';
import { extractUserText, getAssistantText } from './message-helpers';

/** 标题长度上限（用户改名与 AI 生成共用；输入框 maxLength 与后台校验取同一值）。 */
const MAX_SESSION_TITLE_LENGTH = 100;

/** 默认标题取首条消息的前多少个字符。 */
const DEFAULT_TITLE_CHARS = 50;

/** 喂给标题生成模型的对话片段上限（user / assistant 各自），避免长首轮把 prompt 撑爆。 */
const GENERATION_EXCERPT_CHARS = 1500;

/**
 * 新会话的默认标题：首条用户消息压成一行后截断；全空白（如只发了附件）回落「新对话」。
 * 自动标题用它判断「用户是否已经手动改过名」——行标题仍等于这个值才允许覆盖。
 */
function defaultSessionTitle(firstUserText: string): string {
  return truncate(oneLine(firstUserText), DEFAULT_TITLE_CHARS) || t('common.newChat');
}

/**
 * 把用户输入 / 模型输出规整成可落库的标题：压成一行、去首尾空白、超长硬截到上限
 * （用户自己打的字不加省略号）。空返回 null，调用方视为「取消 / 无效」。
 */
function normalizeSessionTitle(input: string): string | null {
  const line = oneLine(input);
  if (!line) return null;
  if (line.length <= MAX_SESSION_TITLE_LENGTH) return line;
  // 按 UTF-16 单元硬截（与输入框 maxLength 同口径）；若正好切在代理对中间，去掉残留的高位半个。
  return line.slice(0, MAX_SESSION_TITLE_LENGTH).replace(/[\uD800-\uDBFF]$/u, '');
}

/** 自动标题的素材：首轮用户原文 + 首轮 assistant 正文。 */
interface TitleSource {
  userText: string;
  assistantText: string;
}

/**
 * 从 transcript 取自动标题的素材。只认「首轮」：恰有一条 user 消息（重试首轮仍算；
 * steer / 划词固化会话的第二轮都不算），且用户原文与 assistant 正文都非空（仅附件 /
 * 仅斜杠提示词的首条没有原文；error / abort 收尾可能没有正文）。不满足返回 null。
 * 触发规则集中在这里，好单测；IO 与落库在 session-manager。
 */
function collectTitleSource(messages: readonly AgentMessage[]): TitleSource | null {
  const users = messages.filter((m) => m.role === 'user');
  if (users.length !== 1) return null;
  const userText = extractUserText(users[0] as Message).trim();
  const assistantText = messages
    .filter((m): m is AssistantMessage => m.role === 'assistant')
    .map(getAssistantText)
    .join('\n')
    .trim();
  if (!userText || !assistantText) return null;
  return { userText, assistantText };
}

/** 自动生成标题的提示词：系统提示 + 用户内容（对话摘录）。 */
interface TitleGenerationPrompt {
  systemPrompt: string;
  userContent: string;
}

const TITLE_SYSTEM_PROMPT = [
  'You write short titles for chat conversations.',
  'Given the first exchange of a conversation, output a concise title that captures its topic.',
  'Rules:',
  '- Use the same language as the conversation.',
  '- At most about 8 words (or 20 characters for CJK languages).',
  '- No quotes, no trailing punctuation, no prefix like "Title:".',
  '- Output the title only, on a single line.',
].join('\n');

function buildTitleGenerationPrompt(userText: string, assistantText: string): TitleGenerationPrompt {
  const user = truncate(userText.trim(), GENERATION_EXCERPT_CHARS);
  const assistant = truncate(assistantText.trim(), GENERATION_EXCERPT_CHARS);
  return {
    systemPrompt: TITLE_SYSTEM_PROMPT,
    userContent: `<user>\n${user}\n</user>\n<assistant>\n${assistant}\n</assistant>`,
  };
}

/** 成对的包裹符号：模型常把标题裹在引号 / 书名号 / 反引号 / Markdown 粗体里。
 *  （i18n lint 只禁源码出现中文汉字，标点不在其中，故这里可以直接写。） */
const WRAPPERS: Array<[string, string]> = [
  ['**', '**'], ['"', '"'], ["'", "'"], ['`', '`'],
  ['“', '”'], ['‘', '’'], ['「', '」'], ['『', '』'], ['《', '》'], ['【', '】'],
];

/** 剥掉句末标点（中英句号 / 叹号 / 问号 / 省略号）。 */
function stripTrailingPunctuation(text: string): string {
  return text.replace(/[.\u3002!\uff01?\uff1f\u2026]+$/u, '').trim();
}

/**
 * 清洗模型输出成标题：取首个非空行，剥掉 `Title:` / `标题：` 一类前缀、成对包裹符号、
 * 句末标点，再过 normalizeSessionTitle。清洗后为空返回 null（调用方保留默认标题）。
 */
function parseGeneratedTitle(raw: string): string | null {
  const firstLine = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return null;
  // 前缀正则里的汉字（标题 / 標題）用转义写：i18n lint 禁止源码出现中文汉字。
  let title = firstLine.replace(/^(title|\u6807\u9898|\u6a19\u984c)\s*[:\uff1a]\s*/i, '');
  // 标点与包裹符号可能任意嵌套（`"Fix bug."` / `` `title`!! ``）：标点 → 包裹 → 标点各剥一遍。
  title = stripTrailingPunctuation(title);
  for (const [open, close] of WRAPPERS) {
    if (title.length >= open.length + close.length && title.startsWith(open) && title.endsWith(close)) {
      const inner = title.slice(open.length, title.length - close.length);
      // 内部还含同款符号（`"A" and "B"`）说明不是整体包裹，别剥——会把正文剥成不对称。
      if (inner.includes(open) || inner.includes(close)) break;
      title = inner.trim();
      break;
    }
  }
  title = stripTrailingPunctuation(title);
  return normalizeSessionTitle(title);
}

export {
  MAX_SESSION_TITLE_LENGTH,
  defaultSessionTitle,
  normalizeSessionTitle,
  collectTitleSource,
  buildTitleGenerationPrompt,
  parseGeneratedTitle,
};

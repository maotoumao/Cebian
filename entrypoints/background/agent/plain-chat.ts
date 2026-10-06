// 把发给 LLM 的消息改写成不含工具协议的纯对话，给关掉了「工具调用」的模型用（#83）。
//
// 只要请求里出现过工具调用或工具结果，pi-ai 的 openai-completions 就会带上 `tools: []` 并
// 发出 `role: 'tool'` 消息——只支持对话的上游照样拒绝。同一会话先用支持工具的模型调过工具、
// 再切到纯对话模型时就会走到这里。作用在 convertToLlm 的产出上：压缩摘要的保留区已经展开，
// 看到的就是最终要发出的消息；只改请求视图，不动 `state.messages`、不落库。

import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolCall,
  UserMessage,
} from '@earendil-works/pi-ai';
import { sanitizeSurrogates } from '@earendil-works/pi-ai/utils/sanitize-unicode';

type UserContent = (TextContent | ImageContent)[];

/** 空 user 消息的占位正文：pi-ai 会丢掉空的 user，留下两条相邻的 assistant。 */
const EMPTY_USER_TEXT = '(empty message)';

function describeToolCall(call: ToolCall): string {
  return `[Tool call: ${call.name}(${JSON.stringify(call.arguments)})]`;
}

function userContent(message: UserMessage): UserContent {
  return typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
}

/**
 * assistant 是否还有 pi-ai 会发出的正文：与 openai-completions 的组装规则一致——只算去掉空白后
 * 非空的 text 块，再清掉未配对的代理字符，拼起来仍非空才算。
 */
function hasSentText(message: AssistantMessage): boolean {
  return message.content.some(
    (block) => block.type === 'text' && block.text.trim().length > 0 && sanitizeSurrogates(block.text).length > 0,
  );
}

/**
 * user 消息在 pi-ai 那里会不会被当成空消息丢掉：数组内容里没有图片、也没有非空文字。
 * 字符串内容 pi-ai 原样发出，不算空。
 */
function isDroppedUser(message: UserMessage): boolean {
  return (
    typeof message.content !== 'string' &&
    !message.content.some((block) => block.type === 'image' || block.text.length > 0)
  );
}

/**
 * 消息改写成纯对话形态；返回 undefined 表示这条不发。
 *
 * pi-ai 发送前会丢掉失败 / 中断的 assistant，以及没有正文的 assistant（只有思考或内容为空——
 * 自定义模型不会把思考当正文发）。这里提前丢掉同样的消息，后面才能看出哪些 user 相邻、并把它们
 * 合并。对同一模型产出的历史这与 pi-ai 一致；别的模型留下的纯思考回复 pi-ai 会转成正文发出，
 * 这里也一并丢掉——它本就不是给用户的回答。
 */
function toPlainMessage(message: Message): Message | undefined {
  switch (message.role) {
    case 'assistant': {
      if (message.stopReason === 'error' || message.stopReason === 'aborted') return undefined;
      const plain: AssistantMessage = message.content.some((block) => block.type === 'toolCall')
        ? {
            ...message,
            content: message.content.map((block) =>
              block.type === 'toolCall' ? { type: 'text' as const, text: describeToolCall(block) } : block,
            ),
          }
        : message;
      return hasSentText(plain) ? plain : undefined;
    }
    case 'toolResult': {
      // 一行说明来自哪个工具、是否出错，再接原内容。图片原样保留，模型不收图片时由 pi-ai 换成占位文字
      const label = message.isError ? 'Tool error' : 'Tool result';
      return {
        role: 'user',
        content: [{ type: 'text', text: `[${label}: ${message.toolName}]` }, ...message.content],
        timestamp: message.timestamp,
      };
    }
    default:
      return message;
  }
}

/**
 * 改写成纯对话，让请求里 user / assistant 严格交替（不少自托管的对话模板有此要求）：
 * 1. 逐条改写（{@link toPlainMessage}）：toolCall 块换成文字，工具结果换成 user 消息，pi-ai
 *    会丢掉的 assistant 提前丢掉；
 * 2. 相邻的 user 合并成一条；
 * 3. 合并完仍会被 pi-ai 当成空消息丢掉的 user 换成占位文字，免得两侧的 assistant 相邻。
 *    放在合并之后：两条空字符串 user 合并后会变成空数组。
 * 没有任何改动时原样返回同一个数组。
 */
function toPlainChat(messages: Message[]): Message[] {
  let changed = false;
  const merged: Message[] = [];
  for (const message of messages) {
    const plain = toPlainMessage(message);
    if (plain !== message) changed = true;
    if (!plain) continue;
    const previous = merged.at(-1);
    if (plain.role === 'user' && previous?.role === 'user') {
      merged[merged.length - 1] = { ...previous, content: [...userContent(previous), ...userContent(plain)] };
      changed = true;
      continue;
    }
    merged.push(plain);
  }
  const result = merged.map((message): Message => {
    if (message.role !== 'user' || !isDroppedUser(message)) return message;
    changed = true;
    return { ...message, content: [{ type: 'text', text: EMPTY_USER_TEXT }] };
  });
  return changed ? result : messages;
}

// ─── 公开 API ───

export { toPlainChat };

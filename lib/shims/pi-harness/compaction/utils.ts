/**
 * 移植自 @earendil-works/pi-agent-core@0.84.4 `src/harness/compaction/utils.ts`（MIT，许可证见同目录 LICENSE）。
 * vendor 原因、维护约定与偏离记录见 lib/shims/pi-harness/README.md。
 */
import { contentText, type Message } from '@earendil-works/pi-ai';

const TOOL_RESULT_MAX_CHARS = 2000;

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '[unserializable]';
  }
}

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const truncatedChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/** Serialize LLM messages to plain text for summarization prompts. */
export function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      const content = contentText(msg.content, '');
      if (content) parts.push(`[User]: ${content}`);
    } else if (msg.role === 'assistant') {
      const thinkingParts: string[] = [];
      const toolCalls: string[] = [];

      for (const block of msg.content) {
        if (block.type === 'thinking') {
          thinkingParts.push(block.thinking);
        } else if (block.type === 'toolCall') {
          const args = block.arguments as Record<string, unknown>;
          const argsStr = Object.entries(args)
            .map(([k, v]) => `${k}=${safeJsonStringify(v)}`)
            .join(', ');
          toolCalls.push(`${block.name}(${argsStr})`);
        }
      }

      if (thinkingParts.length > 0) {
        parts.push(`[Assistant thinking]: ${thinkingParts.join('\n')}`);
      }
      if (msg.content.some((block) => block.type === 'text')) {
        parts.push(`[Assistant]: ${contentText(msg.content)}`);
      }
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join('; ')}`);
      }
    } else if (msg.role === 'toolResult') {
      const content = contentText(msg.content, '');
      if (content) {
        parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
      }
    }
  }

  return parts.join('\n\n');
}

/**
 * 移植自 @earendil-works/pi-agent-core@0.84.4 `src/harness/messages.ts`（MIT，许可证见同目录 LICENSE）。
 * vendor 原因、维护约定与偏离记录见 lib/shims/pi-harness/README.md。
 */
import type { ImageContent, Message, TextContent } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

export interface BashExecutionMessage {
  role: 'bashExecution';
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
  excludeFromContext?: boolean;
}

export interface CustomMessage<T = unknown> {
  role: 'custom';
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: T;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: 'branchSummary';
  summary: string;
  fromId: string;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: 'compactionSummary';
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

declare module '@earendil-works/pi-agent-core' {
  interface CustomAgentMessages {
    bashExecution: BashExecutionMessage;
    custom: CustomMessage;
    branchSummary: BranchSummaryMessage;
    compactionSummary: CompactionSummaryMessage;
  }
}

export function bashExecutionToText(msg: BashExecutionMessage): string {
  let text = `Ran \`${msg.command}\`\n`;
  if (msg.output) {
    text += `\`\`\`\n${msg.output}\n\`\`\``;
  } else {
    text += '(no output)';
  }
  if (msg.cancelled) {
    text += '\n\n(command cancelled)';
  } else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
    text += `\n\nCommand exited with code ${msg.exitCode}`;
  }
  if (msg.truncated && msg.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
  }
  return text;
}

export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages
    .map((m): Message | undefined => {
      switch (m.role) {
        case 'bashExecution':
          if (m.excludeFromContext) {
            return undefined;
          }
          return {
            role: 'user',
            content: [{ type: 'text', text: bashExecutionToText(m) }],
            timestamp: m.timestamp,
          };
        case 'custom': {
          const content = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
          return {
            role: 'user',
            content,
            timestamp: m.timestamp,
          };
        }
        case 'branchSummary':
          return {
            role: 'user',
            content: [{ type: 'text' as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
            timestamp: m.timestamp,
          };
        case 'compactionSummary':
          return {
            role: 'user',
            content: [
              { type: 'text' as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
            ],
            timestamp: m.timestamp,
          };
        case 'user':
        case 'assistant':
        case 'toolResult':
          return m;
        default:
          return undefined;
      }
    })
    .filter((m): m is Message => m !== undefined);
}

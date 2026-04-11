import { useState, useRef, useEffect } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChatInput } from '@/components/chat/ChatInput';
import {
  UserMessageBubble,
  AgentMessage,
  ThinkingBlock,
  ClarificationBox,
  ExecutionResult,
} from '@/components/chat/Message';
import { ToolCard } from '@/components/chat/ToolCard';
import type {
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
} from '@/lib/types';
import {
  TOOL_ASK_USER,
  TOOL_EXECUTE_SCRIPT,
  getAssistantText,
  getThinkingBlocks,
  getToolCalls,
  findToolResult,
} from '@/lib/types';

// ─── Stub usage/metadata for demo messages ───

const STUB_META = {
  api: 'anthropic-messages' as const,
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

const now = Date.now();

const DEMO_MESSAGES: Message[] = [
  // 1. User asks to analyze forms
  {
    role: 'user',
    content: '帮我分析一下当前页面的表单，找出所有带 name 属性的输入框，并用红框高亮出来。',
    timestamp: now - 5000,
  },
  // 2. Agent thinks, then asks user to clarify via ask_user tool
  {
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking:
          'Reading document structure...\nQuerying for `form` tags: Found 3 matches.\nFiltering forms: Two contain `input[name]`.\nDiscovered: #login-form (4 inputs) and #newsletter-sub (1 input).',
      },
      {
        type: 'text',
        text: '我扫描了当前页面，发现有两个不同的表单区域（顶部的登录表单，以及侧边栏的订阅表单）。',
      },
      {
        type: 'toolCall',
        id: 'tc_ask_1',
        name: TOOL_ASK_USER,
        arguments: {
          title: '需要更明确的目标',
          description: '你想让我高亮哪一个？',
          options: [
            { label: '仅高亮 #login-form' },
            { label: '仅高亮 #newsletter-sub' },
            { label: '全部高亮 (All)', primary: true },
          ],
        },
      },
    ],
    ...STUB_META,
    stopReason: 'toolUse',
    timestamp: now - 4000,
  },
  // 3. User's selection becomes the tool result
  {
    role: 'toolResult',
    toolCallId: 'tc_ask_1',
    toolName: TOOL_ASK_USER,
    content: [{ type: 'text', text: '全部高亮 (All)' }],
    isError: false,
    timestamp: now - 3000,
  },
  // 4. Agent executes script
  {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '没问题，我将通过注入 DOM 脚本为它们添加红色高亮边框。稍等...',
      },
      {
        type: 'toolCall',
        id: 'tc_exec_1',
        name: TOOL_EXECUTE_SCRIPT,
        arguments: {
          code: `const inputs = document.querySelectorAll(
  'input[name], select[name], textarea[name]'
);
inputs.forEach(el => {
  el.style.border = '2px solid red';
  el.style.boxShadow = '0 0 8px rgba(255,0,0,0.5)';
});
return inputs.length;`,
        },
      },
    ],
    ...STUB_META,
    stopReason: 'toolUse',
    timestamp: now - 2000,
  },
  // 5. Script execution result
  {
    role: 'toolResult',
    toolCallId: 'tc_exec_1',
    toolName: TOOL_EXECUTE_SCRIPT,
    content: [{ type: 'text', text: '执行完毕。在页面中找到了 5 个匹配的表单载体，并已作高亮处理。' }],
    isError: false,
    timestamp: now - 1000,
  },
];

// ─── Tool-call renderer ───

function ToolCallRenderer({
  tc,
  messages,
  onUserReply,
}: {
  tc: import('@/lib/types').ToolCall;
  messages: Message[];
  onUserReply: (toolCallId: string, text: string) => void;
}) {
  const result = findToolResult(messages, tc.id);

  switch (tc.name) {
    case TOOL_ASK_USER: {
      const args = tc.arguments as {
        title: string;
        description: string;
        options: { label: string; primary?: boolean }[];
      };
      return (
        <ClarificationBox
          title={args.title}
          description={args.description}
          options={args.options}
          answered={!!result}
          onSelect={(label) => onUserReply(tc.id, label)}
        />
      );
    }
    case TOOL_EXECUTE_SCRIPT: {
      const code =
        typeof tc.arguments.code === 'string'
          ? tc.arguments.code
          : JSON.stringify(tc.arguments, null, 2);
      const status = !result ? 'running' : result.isError ? 'error' : 'done';
      return (
        <>
          <ToolCard name={tc.name} status={status} code={code} />
          {result && !result.isError && (
            <ExecutionResult
              message={
                result.content
                  .filter((b) => b.type === 'text')
                  .map((b) => b.text)
                  .join('')
              }
            />
          )}
        </>
      );
    }
    default: {
      const code = JSON.stringify(tc.arguments, null, 2);
      const status = !result ? 'running' : result.isError ? 'error' : 'done';
      return <ToolCard name={tc.name} status={status} code={code} />;
    }
  }
}

// ─── ChatPage ───

export function ChatPage() {
  const [messages, setMessages] = useState<Message[]>(DEMO_MESSAGES);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const handleSend = (text: string) => {
    const userMsg: UserMessage = {
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
  };

  const handleToolReply = (toolCallId: string, text: string) => {
    const toolResult: ToolResultMessage = {
      role: 'toolResult',
      toolCallId,
      toolName: TOOL_ASK_USER,
      content: [{ type: 'text', text }],
      isError: false,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, toolResult]);
  };

  return (
    <>
      <ScrollArea className="flex-1" ref={scrollRef}>
        <div className="flex flex-col gap-6 p-5">
          {messages.map((msg) => {
            // User messages
            if (msg.role === 'user') {
              return (
                <UserMessageBubble key={msg.timestamp}>
                  {typeof msg.content === 'string'
                    ? msg.content
                    : msg.content
                        .filter((b) => b.type === 'text')
                        .map((b) => b.text)
                        .join('')}
                </UserMessageBubble>
              );
            }

            // Assistant messages — render content blocks in order
            if (msg.role === 'assistant') {
              const thinkingBlocks = getThinkingBlocks(msg);
              const text = getAssistantText(msg);
              const toolCalls = getToolCalls(msg);

              return (
                <AgentMessage key={msg.timestamp}>
                  {thinkingBlocks.map((block, i) => (
                    <ThinkingBlock key={i} content={block.thinking} />
                  ))}

                  {text && <p>{text}</p>}

                  {toolCalls.map((tc) => (
                    <ToolCallRenderer
                      key={tc.id}
                      tc={tc}
                      messages={messages}
                      onUserReply={handleToolReply}
                    />
                  ))}
                </AgentMessage>
              );
            }

            // toolResult messages — rendered inline via ToolCallRenderer, skip standalone
            return null;
          })}
        </div>
      </ScrollArea>

      <ChatInput onSend={handleSend} />
    </>
  );
}

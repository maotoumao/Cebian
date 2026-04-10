import { useState, useRef, useEffect } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Header } from '@/components/chat/Header';
import { ChatInput } from '@/components/chat/ChatInput';
import { SettingsPanel } from '@/components/chat/SettingsPanel';
import {
  UserMessage,
  AgentMessage,
  ThinkingProcess,
  ClarificationBox,
  ExecutionResult,
} from '@/components/chat/Message';
import { ToolCard } from '@/components/chat/ToolCard';

type Theme = 'dark' | 'light';

interface ChatMessage {
  id: number;
  role: 'user' | 'agent';
  content: string;
  toolCard?: { name: string; status: 'running' | 'done' | 'error'; code: string };
  thinking?: { title: string; steps: string[] };
  clarification?: {
    title: string;
    description: string;
    options: { label: string; primary?: boolean }[];
  };
  result?: {
    message: string;
    actions?: { label: string; primary?: boolean }[];
  };
}

const DEMO_MESSAGES: ChatMessage[] = [
  {
    id: 1,
    role: 'user',
    content:
      '帮我分析一下当前页面的表单，找出所有带 name 属性的输入框，并用红框高亮出来。',
  },
  {
    id: 2,
    role: 'agent',
    content:
      '我扫描了当前页面，发现有两个不同的表单区域（顶部的登录表单，以及侧边栏的订阅表单）。',
    thinking: {
      title: 'Thinking Process (Analyzed DOM)',
      steps: [
        'Reading document structure...',
        'Querying for `form` tags: Found 3 matches.',
        'Filtering forms: Two contain `input[name]`.',
        'Discovered: #login-form (4 inputs) and #newsletter-sub (1 input).',
      ],
    },
    clarification: {
      title: '需要更明确的目标',
      description: '你想让我高亮哪一个？',
      options: [
        { label: '仅高亮 #login-form' },
        { label: '仅高亮 #newsletter-sub' },
        { label: '全部高亮 (All)', primary: true },
      ],
    },
  },
  {
    id: 3,
    role: 'user',
    content: '全部高亮 (All)',
  },
  {
    id: 4,
    role: 'agent',
    content: '没问题，我将通过注入 DOM 脚本为它们添加红色高亮边框。稍等...',
    toolCard: {
      name: 'executeScript',
      status: 'running',
      code: `const inputs = document.querySelectorAll(
  'input[name], select[name], textarea[name]'
);
inputs.forEach(el => {
  el.style.border = '2px solid red';
  el.style.boxShadow = '0 0 8px rgba(255,0,0,0.5)';
});
return inputs.length;`,
    },
    result: {
      message: '执行完毕。在页面中找到了 5 个匹配的表单载体，并已作高亮处理。',
      actions: [
        { label: 'View Extracted JSON', primary: true },
        { label: 'Clear Styles' },
      ],
    },
  },
];

function App() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(DEMO_MESSAGES);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, [theme]);

  // Auto-scroll on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const handleSend = (text: string) => {
    setMessages((prev) => [
      ...prev,
      { id: Date.now(), role: 'user', content: text },
    ]);
  };

  const toggleTheme = () =>
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex flex-col h-screen overflow-hidden relative">
        <Header
          theme={theme}
          onToggleTheme={toggleTheme}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        {/* Chat Area */}
        <ScrollArea className="flex-1" ref={scrollRef}>
          <div className="flex flex-col gap-6 p-5">
            {messages.map((msg) => {
              if (msg.role === 'user') {
                return (
                  <UserMessage key={msg.id}>{msg.content}</UserMessage>
                );
              }

              return (
                <AgentMessage key={msg.id}>
                  {msg.thinking && (
                    <ThinkingProcess
                      title={msg.thinking.title}
                      steps={msg.thinking.steps}
                    />
                  )}

                  <p>{msg.content}</p>

                  {msg.clarification && (
                    <ClarificationBox
                      title={msg.clarification.title}
                      description={msg.clarification.description}
                      options={msg.clarification.options}
                      onSelect={(label) => handleSend(label)}
                    />
                  )}

                  {msg.toolCard && (
                    <ToolCard
                      name={msg.toolCard.name}
                      status={msg.toolCard.status}
                      code={msg.toolCard.code}
                    />
                  )}

                  {msg.result && (
                    <ExecutionResult
                      message={msg.result.message}
                      actions={msg.result.actions}
                    />
                  )}
                </AgentMessage>
              );
            })}
          </div>
        </ScrollArea>

        {/* Input */}
        <ChatInput onSend={handleSend} />

        {/* Settings Overlay */}
        <SettingsPanel
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      </div>
    </TooltipProvider>
  );
}

export default App;

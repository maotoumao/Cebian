// ─── Provider registry ───

import type { CustomProviderConfig } from './storage';

export const OAUTH_PROVIDERS = [
  { provider: 'github-copilot', label: 'GitHub Copilot', description: '使用 Copilot 订阅访问 GPT/Claude', flow: 'device-code' as const },
  { provider: 'openai-codex', label: 'OpenAI Codex', description: '使用 ChatGPT Plus/Pro 订阅', flow: 'auth-code' as const },
  { provider: 'google-gemini-cli', label: 'Google Gemini', description: 'Google Cloud OAuth 登录', flow: 'auth-code' as const },
] as const;

export const APIKEY_PROVIDERS = [
  { provider: 'anthropic', label: 'Anthropic' },
  { provider: 'openai', label: 'OpenAI' },
  { provider: 'google', label: 'Google Gemini' },
  { provider: 'xai', label: 'xAI' },
  { provider: 'groq', label: 'Groq' },
  { provider: 'openrouter', label: 'OpenRouter' },
  { provider: 'mistral', label: 'Mistral' },
  { provider: 'minimax', label: 'MiniMax' },
  { provider: 'minimax-cn', label: 'MiniMax (CN)' },
  { provider: 'kimi-coding', label: 'Kimi' },
] as const;

// ─── Preset custom providers (OpenAI-compatible) ───

export const PRESET_PROVIDERS: readonly CustomProviderConfig[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: [
      { modelId: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: false, contextWindow: 65536, maxTokens: 8192 },
      { modelId: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: true, contextWindow: 65536, maxTokens: 8192 },
    ],
  },
];

// ─── Default system prompt ───

export const DEFAULT_SYSTEM_PROMPT = `You are Cebian, an AI assistant embedded in a Chrome browser extension sidebar.

You can see and interact with the user's current browser tab. You have access to the Chrome DevTools Protocol (CDP) and can inject JavaScript into web pages.

Your capabilities include:
- Analyzing page structure, DOM elements, and forms
- Executing JavaScript in the active tab
- Reading and modifying page content
- Taking screenshots and capturing network traffic
- Profiling performance and accessibility

Each user message is automatically preceded by a <cebian-context> block containing:
- The active tab's URL, title, and page metadata (description, keywords, lang, etc.)
- Any text the user has selected on the page
- A list of all open tabs in the current window (the active tab is marked with *)
Use this context to understand what the user is looking at. When they say "this page" or "当前页面", refer to the Active Tab. Do not mention the context block to the user — it is injected automatically and invisible to them.

When the user asks you to interact with a page, use the available tools. Be concise and precise in your responses. Prefer Chinese for responses unless the user writes in English.`;

// ─── Slash commands ───

export const SLASH_COMMANDS = [
  { icon: '⚡️', name: '/profile', desc: 'Intercept & Profile Network (CDP)' },
  { icon: '📋', name: '/summarize', desc: 'Extract & Summarize current page' },
  { icon: '⏱️', name: '/rpa', desc: 'Set background timer loop via SW' },
] as const;

// ─── Provider registry ───

export const OAUTH_PROVIDERS = [
  { provider: 'github-copilot', label: 'GitHub Copilot', description: '使用 Copilot 订阅访问 GPT/Claude' },
  { provider: 'openai-codex', label: 'OpenAI Codex', description: '使用 ChatGPT Plus/Pro 订阅' },
  { provider: 'google-gemini-cli', label: 'Google Gemini', description: 'Google Cloud OAuth 登录' },
] as const;

export const APIKEY_PROVIDERS = [
  { provider: 'anthropic', label: 'Anthropic' },
  { provider: 'openai', label: 'OpenAI' },
  { provider: 'google', label: 'Google Gemini' },
  { provider: 'xai', label: 'xAI' },
  { provider: 'groq', label: 'Groq' },
  { provider: 'openrouter', label: 'OpenRouter' },
  { provider: 'mistral', label: 'Mistral' },
] as const;

// ─── Slash commands ───

export const SLASH_COMMANDS = [
  { icon: '⚡️', name: '/profile', desc: 'Intercept & Profile Network (CDP)' },
  { icon: '📋', name: '/summarize', desc: 'Extract & Summarize current page' },
  { icon: '⏱️', name: '/rpa', desc: 'Set background timer loop via SW' },
] as const;

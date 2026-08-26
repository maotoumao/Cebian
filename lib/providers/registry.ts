// ─── Provider registry ───

import { t } from '@/lib/i18n';

export const OAUTH_PROVIDERS = [
  { provider: 'github-copilot', label: 'GitHub Copilot', getDescription: () => t('provider.oauth.descriptions.githubCopilot'), flow: 'device-code' as const },
  { provider: 'openai-codex', label: 'OpenAI Codex', getDescription: () => t('provider.oauth.descriptions.openaiCodex'), flow: 'auth-code' as const },
] as const satisfies readonly {
  provider: string;
  label: string;
  getDescription: () => string;
  flow: 'device-code' | 'auth-code';
}[];

export const APIKEY_PROVIDERS = [
  { provider: 'ant-ling', label: 'Ant Ling' },
  { provider: 'anthropic', label: 'Anthropic', pinned: true },
  { provider: 'cerebras', label: 'Cerebras' },
  { provider: 'deepseek', label: 'DeepSeek', pinned: true },
  { provider: 'fireworks', label: 'Fireworks' },
  { provider: 'google', label: 'Google Gemini', pinned: true },
  { provider: 'groq', label: 'Groq' },
  { provider: 'huggingface', label: 'Hugging Face' },
  { provider: 'kimi-coding', label: 'Kimi Coding Plan' },
  { provider: 'minimax', label: 'MiniMax' },
  { provider: 'minimax-cn', label: 'MiniMax (CN)' },
  { provider: 'mistral', label: 'Mistral' },
  { provider: 'moonshotai', label: 'Moonshot' },
  { provider: 'moonshotai-cn', label: 'Moonshot (CN)' },
  { provider: 'nvidia', label: 'NVIDIA NIM' },
  { provider: 'openai', label: 'OpenAI', pinned: true },
  { provider: 'openrouter', label: 'OpenRouter', pinned: true },
  { provider: 'orcarouter', label: 'OrcaRouter' },
  { provider: 'together', label: 'Together AI' },
  { provider: 'vercel-ai-gateway', label: 'Vercel AI Gateway' },
  { provider: 'xai', label: 'xAI' },
  { provider: 'xiaomi', label: 'Xiaomi MiMo' },
  { provider: 'xiaomi-token-plan-cn', label: 'Xiaomi MiMo Plan (CN)' },
  { provider: 'zai', label: 'zAI' },
] as const;

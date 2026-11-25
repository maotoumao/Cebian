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
  { provider: 'opencode-go', label: 'OpenCode Go' },
  { provider: 'openrouter', label: 'OpenRouter', pinned: true },
  { provider: 'together', label: 'Together AI' },
  { provider: 'vercel-ai-gateway', label: 'Vercel AI Gateway' },
  { provider: 'xai', label: 'xAI' },
  { provider: 'xiaomi', label: 'Xiaomi MiMo' },
  { provider: 'xiaomi-token-plan-cn', label: 'Xiaomi MiMo Plan (CN)' },
  { provider: 'zai', label: 'zAI' },
] as const;

/**
 * 用专用鉴权接口验证 API key 的 provider（provider → GET 地址）。其余 provider 的连通性测试
 * 拿最便宜的模型发一次补全；OpenCode Go 最便宜的是有地区限制的免费模型，不少付费模型还要
 * 先在工作区隐私设置里放开，探测补全常把有效的 key 判成「未验证」。usage 接口只校验 key、
 * 不消耗额度：401 = key 无效，403 = 不在 Go 订阅范围（响应里带原因）。
 *
 * 调用约定（verifyKeyAtEndpoint）：GET + `Authorization: Bearer <key>`，2xx 即有效，失败时
 * 从响应体 `{ error: { message } }` 取原因。新加的 provider 接口不符合这个约定就得另写校验。
 */
export const API_KEY_CHECK_URLS: Partial<Record<string, string>> = {
  'opencode-go': 'https://opencode.ai/inference/go/v1/usage',
};

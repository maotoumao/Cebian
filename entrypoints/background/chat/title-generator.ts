// 自动生成会话标题的 LLM 调用（一次性、非 agent、不走会话树）。何时触发、如何比对与落库
// 在 session-manager 的 maybeGenerateTitle；提示词与结果清洗是 lib/agent/session-title 的纯函数。

import type { Api, Model } from '@earendil-works/pi-ai';
import { complete } from '@earendil-works/pi-ai/compat';
import { getAssistantText } from '@/lib/agent/message-helpers';
import { buildTitleGenerationPrompt, parseGeneratedTitle } from '@/lib/agent/session-title';

/**
 * 输出预算。标题本身只要几十 token，但 `complete()` 不带 reasoning 选项、推理模型的思考
 * token 也算在这个预算里：给太少会让 o 系列 / Gemini 2.5 一类模型把预算全花在思考上、
 * 一个 text 块都没有。清洗只取首个非空行并截到 100 字，所以放宽预算不影响结果质量。
 */
const TITLE_MAX_TOKENS = 256;

interface GenerateSessionTitleParams {
  model: Model<Api>;
  apiKey: string;
  /** 首轮用户原文（已去掉 <user-request> 信封）。 */
  userText: string;
  /** 首轮 assistant 正文（多段拼接）。 */
  assistantText: string;
  signal?: AbortSignal;
}

/**
 * 用一次短补全生成标题。返回清洗后的标题；模型输出不可用（空 / 全是标点）或请求被取消
 * 返回 null。provider 错误以 throw 抛出，由调用方决定记日志还是忽略。
 *
 * `complete()` 在某些失败路径上会 resolve 一个 Error 而非 reject（ProviderApiKeyItem 的先例
 * 也做了这层防御），这里统一转成 throw。
 */
async function generateSessionTitle(params: GenerateSessionTitleParams): Promise<string | null> {
  const { systemPrompt, userContent } = buildTitleGenerationPrompt(params.userText, params.assistantText);
  const result = await complete(
    params.model,
    { systemPrompt, messages: [{ role: 'user', content: userContent, timestamp: Date.now() }] },
    { apiKey: params.apiKey, maxTokens: TITLE_MAX_TOKENS, signal: params.signal },
  );
  if (result instanceof Error) throw result;
  if (result.stopReason === 'aborted') return null;
  if (result.stopReason === 'error') {
    throw new Error(result.errorMessage ?? 'title generation failed');
  }
  const title = parseGeneratedTitle(getAssistantText(result));
  if (!title) {
    // 常见原因：模型默认开启 reasoning，把预算全花在思考上、没有正文。
    // 留一条 debug，免得「自动标题不工作」无从排查。
    console.debug('[auto-title] model returned no usable text', { stopReason: result.stopReason });
  }
  return title;
}

export { generateSessionTitle };

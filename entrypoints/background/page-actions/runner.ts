// 划词动作（翻译 / 解释）的 background 侧流式执行器。
//
// 住在 entrypoints/background/page-actions/ 而非 lib/page-actions/：它要用
// resolveProviderApiKey（同级 providers/credentials.ts）解析凭证 + OAuth 刷新，且要经
// sessionStore 落库（background 是 Dexie 唯一写者），lib 不反向 import entrypoints。经
// setupPageActions 注入回 lib 的端口编排（DI，保持 lib/page-actions 概念内聚且无
// entrypoint 依赖）。
//
// 「短暂调用」：直接调 pi-ai 流式，不走 session-manager、不建 session、不落库。

import { stream } from '@earendil-works/pi-ai/compat';
import type { Api, Model, UserMessage, AssistantMessage } from '@earendil-works/pi-ai';
import { resolveModel } from '@/lib/providers/resolve-model';
import {
  providerCredentials,
  customProviders,
  lastSelectedModel,
  pageInteractionSettings,
  pendingSidePanelHandoff,
  resolvePageInteractionSettings,
  type PageInteractionSettings,
} from '@/lib/persistence/storage';
import type { SessionRecord } from '@/lib/persistence/db';
import { getPageAction, type PageActionParams } from '@/lib/page-actions/actions';
import type { PageActionId, PageActionRequest } from '@/lib/page-actions/types';
import { resolveProviderApiKey } from '../providers/credentials';
import { sessionStore } from '../chat/session-store';

/** 语言代码 → 英文语言名（供提示词用，稳健且模型易懂）；失败回退代码本身。 */
function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** 按动作解析渲染参数：翻译目标语言（空 = 跟随界面语言）、解释回复语言（界面语言）。
 *  内置动作的参数来自设置，故在此解析（content 只传原始 request）。 */
function resolveParams(actionId: PageActionId, settings: PageInteractionSettings): PageActionParams {
  const uiLang = chrome.i18n.getUILanguage();
  if (actionId === 'translate') {
    return { target: languageName(settings.translateTarget || uiLang) };
  }
  return { lang: languageName(uiLang) };
}

/** 解析工具条动作要用的模型 + 凭证：toolbarModel 优先，未配置 / 解析不出回退主模型；
 *  都不可用则 throw。 */
async function resolveActionModel(
  settings: PageInteractionSettings,
): Promise<{ model: Model<Api>; apiKey: string | undefined }> {
  const [creds, customProvs, globalModel] = await Promise.all([
    providerCredentials.getValue(),
    customProviders.getValue(),
    lastSelectedModel.getValue(),
  ]);
  const model =
    (settings.toolbarModel && resolveModel(settings.toolbarModel, creds, customProvs ?? [])) ||
    (globalModel && resolveModel(globalModel, creds, customProvs ?? []));
  if (!model) {
    throw new Error('No usable model for page actions (configure a model in settings)');
  }
  const apiKey = await resolveProviderApiKey(model.provider);
  return { model, apiKey };
}

/** 执行一次划词动作的流式调用，逐 delta 回调；成功 resolve，失败 throw。 */
export async function runPageActionStream(
  request: PageActionRequest,
  handlers: { onDelta: (delta: string) => void; signal: AbortSignal },
): Promise<void> {
  const def = getPageAction(request.actionId);
  if (!def) throw new Error(`Unknown page action: ${request.actionId}`);

  const settings = resolvePageInteractionSettings(await pageInteractionSettings.getValue());
  // 渲染参数 = 设置解析出的（翻译目标 / 回复语言）+ 内容脚本随请求带来的有界上下文。
  const contextParam = typeof request.params.context === 'string' ? request.params.context : '';
  const params: PageActionParams = {
    ...resolveParams(request.actionId, settings),
    ...(contextParam ? { context: contextParam } : {}),
  };
  const { model, apiKey } = await resolveActionModel(settings);

  const events = stream(
    model,
    {
      systemPrompt: def.renderSystemPrompt(params),
      messages: [
        { role: 'user', content: def.renderUserIntent(request.text, params), timestamp: Date.now() },
      ],
    },
    { apiKey, signal: handlers.signal },
  );

  for await (const ev of events) {
    if (ev.type === 'text_delta') {
      handlers.onDelta(ev.delta);
    } else if (ev.type === 'error') {
      // aborted 是我们主动取消（换选区 / 关卡片），不当错误上报。
      if (ev.reason === 'aborted') return;
      throw new Error(ev.error.errorMessage || 'Stream error');
    }
  }
}

// 空 usage（固化的历史 assistant 消息无真实计量；字段仅元数据）。
const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 会话标题：选中原文去空白截断。 */
function makeTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > 48 ? `${t.slice(0, 48)}…` : t || 'Cebian';
}

/**
 * 「在侧边栏继续」（做法2）：把一次划词交互固化成一条真实会话（user 干净意图 +
 * assistant 已生成结果两条历史），写 pending 交接标记供侧边栏跳转。续聊用主模型
 * （主模型不可用回退工具条模型）。background 是 Dexie 唯一写者，故在此 create。
 * 纯内联划词不落库；只有显式点「继续」才走这条固化路径。
 */
export async function materializeHandoff(
  req: {
    actionId: PageActionId;
    text: string;
    result: string;
  },
  windowId: number,
): Promise<void> {
  const def = getPageAction(req.actionId);
  if (!def) throw new Error(`Unknown page action: ${req.actionId}`);
  const settings = resolvePageInteractionSettings(await pageInteractionSettings.getValue());
  const params = resolveParams(req.actionId, settings);

  const [creds, customProvs, globalModel] = await Promise.all([
    providerCredentials.getValue(),
    customProviders.getValue(),
    lastSelectedModel.getValue(),
  ]);
  // 续聊优先主模型；主模型不可解析回退工具条模型，保证会话有可解析模型。
  const identity =
    (globalModel && resolveModel(globalModel, creds, customProvs ?? []) ? globalModel : null) ??
    (settings.toolbarModel && resolveModel(settings.toolbarModel, creds, customProvs ?? [])
      ? settings.toolbarModel
      : null);
  if (!identity) throw new Error('No usable model to continue in sidebar');
  const model = resolveModel(identity, creds, customProvs ?? [])!;

  const now = Date.now();
  const userMsg: UserMessage = {
    role: 'user',
    content: def.renderUserIntent(req.text, params),
    timestamp: now,
  };
  const assistantMsg: AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: req.result }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: EMPTY_USAGE,
    stopReason: 'stop',
    timestamp: now,
  };
  const session: SessionRecord = {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    title: makeTitle(req.text),
    model: identity.modelId,
    provider: identity.provider,
    userInstructions: '',
    thinkingLevel: 'medium',
    messages: [userMsg, assistantMsg],
    messageCount: 2,
  };
  await sessionStore.create(session);
  await pendingSidePanelHandoff.setValue({ sessionId: session.id, windowId });
}

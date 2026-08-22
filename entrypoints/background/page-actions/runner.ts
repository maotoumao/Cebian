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
import { languageName, oneLine, truncate } from '@/lib/utils';
import {
  providerCredentials,
  customProviders,
  lastSelectedModel,
  pageActionsConfig,
  pageInteractionSettings,
  pendingSidePanelHandoff,
  resolvePageActionsConfig,
  resolvePageInteractionSettings,
  type PageInteractionSettings,
} from '@/lib/persistence/storage';
import {
  findPageAction,
  stringParams,
  type PageActionParams,
  type ResolvedPageAction,
} from '@/lib/page-actions/actions';
import type {
  PageActionId,
  PageActionOutcome,
  PageActionRequest,
} from '@/lib/page-actions/types';
import { resolveProviderApiKey } from '../providers/credentials';
import { sessionStore } from '../chat/session-store';
import { runTransform } from './transform';

/**
 * 内置动作的渲染参数：翻译目标语言（空 = 跟随界面语言）、解释 / 总结的回复语言（界面
 * 语言）。这些参数来自设置，故在 background 解析（内容脚本只传页面侧素材）。
 */
function builtinParams(actionId: PageActionId, settings: PageInteractionSettings): PageActionParams {
  const uiLang = chrome.i18n.getUILanguage();
  if (actionId === 'translate') {
    return { target: languageName(settings.translateTarget || uiLang) };
  }
  return { lang: languageName(uiLang) };
}

/**
 * 环境变量：运行时能读到的事实。页面侧的 selected_text / context / page_url /
 * page_title 由内容脚本随请求带上，date / ui_language 在此补齐。
 *
 * 自定义动作的提示词模板与所有动作的脚本钩子**共用同一套**，与动作是内置还是自定义
 * 无关——同一个 `vars` 在哪儿都得是同一个意思。内置动作渲染提示词用的 target / lang
 * 是「设置解析出来的参数」，不属于环境变量，故刻意不混进来（脚本不透传设置项）。
 *
 * `ui_language` 给的是**英文语言名**而非 BCP-47 代码——与内置动作给模型的说法一致，
 * 且 "Reply in Chinese" 比 "Reply in zh-CN" 对模型稳当。
 */
function envVars(request: PageActionRequest): Record<string, string> {
  return stringParams({
    ...request.params,
    selected_text: request.text,
    date: new Date().toLocaleDateString(),
    ui_language: languageName(chrome.i18n.getUILanguage()),
  });
}

/** 一次动作执行要用的提示词渲染参数：内置走设置解析，自定义直接用环境变量。 */
function resolveParams(
  action: ResolvedPageAction,
  vars: Record<string, string>,
  settings: PageInteractionSettings,
): PageActionParams {
  if (action.kind === 'builtin') {
    const contextParam = vars.context ?? '';
    return {
      ...builtinParams(action.id, settings),
      ...(contextParam ? { context: contextParam } : {}),
    };
  }
  return vars;
}

/** 取一个已解析动作；id 查不到定义就诚实报错（内容脚本可能带来陈旧 / 伪造的 id）。 */
async function loadAction(actionId: PageActionId): Promise<ResolvedPageAction> {
  const config = resolvePageActionsConfig(await pageActionsConfig.getValue());
  const action = findPageAction(config, actionId);
  if (!action) throw new Error(`Unknown page action: ${actionId}`);
  return action;
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

/**
 * 执行一次划词动作的流式调用，逐 delta 回调；成功 resolve 出收尾信息，失败 throw。
 *
 * 配了后处理脚本的动作在全文生成完后再跑脚本（脚本要看完整输出，天然不能流式），
 * 结果随 done 回传给内容脚本替换展示。脚本失败只降级成提示——它是锦上添花，不该
 * 把一次已经成功的生成变成失败。
 */
export async function runPageActionStream(
  request: PageActionRequest,
  handlers: { onDelta: (delta: string) => void; signal: AbortSignal },
): Promise<PageActionOutcome> {
  const action = await loadAction(request.actionId);
  const settings = resolvePageInteractionSettings(await pageInteractionSettings.getValue());
  // 环境变量一次动作只取一份快照：提示词渲染与后处理脚本共用它，免得两处各算一次
  // （`date` 在跨午夜那一刻会不一致）。
  const vars = envVars(request);
  const params = resolveParams(action, vars, settings);
  const { model, apiKey } = await resolveActionModel(settings);

  const events = stream(
    model,
    {
      systemPrompt: action.renderSystemPrompt(params),
      messages: [
        {
          role: 'user',
          content: action.renderUserIntent(request.text, params),
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey, signal: handlers.signal },
  );

  let output = '';
  for await (const ev of events) {
    if (ev.type === 'text_delta') {
      output += ev.delta;
      handlers.onDelta(ev.delta);
    } else if (ev.type === 'error') {
      // aborted 是我们主动取消（换选区 / 关卡片），不当错误上报。
      if (ev.reason === 'aborted') return {};
      throw new Error(ev.error.errorMessage || 'Stream error');
    }
  }

  if (!action.transform) return {};
  // 取消后不必再跑脚本（卡片已经关了）。
  if (handlers.signal.aborted) return {};
  try {
    // 脚本拿的是环境变量，不是提示词渲染参数——内置动作也一样，故传 vars 而不是 params。
    return { transformed: await runTransform(action.transform, output, vars) };
  } catch (err) {
    console.warn('[page-actions] transform failed:', err);
    return { transformError: (err as Error).message };
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

/** 会话标题：选中原文压成一行再截断；全空白则回落扩展名。 */
function makeTitle(text: string): string {
  return truncate(oneLine(text), 48) || 'Cebian';
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
  const action = await loadAction(req.actionId);
  const settings = resolvePageInteractionSettings(await pageInteractionSettings.getValue());
  // 固化历史只需要 user turn，自定义动作的 user turn 就是原文，与模板变量无关。
  const params = action.kind === 'builtin' ? builtinParams(action.id, settings) : {};

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
    content: action.renderUserIntent(req.text, params),
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
  const sessionId = crypto.randomUUID();
  await sessionStore.createWithMessages(
    {
      id: sessionId,
      title: makeTitle(req.text),
      model: identity.modelId,
      provider: identity.provider,
      userInstructions: '',
      thinkingLevel: 'medium',
    },
    [userMsg, assistantMsg],
  );
  await pendingSidePanelHandoff.setValue({ sessionId, windowId });
}

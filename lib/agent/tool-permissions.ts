// 工具权限门禁（tool permission gate）领域模块：集中存放「某些工具在执行前
// 需要用户显式授权」这一横切特性。
//
// 一个自包含的 agent 横切域模块，被 `agent.ts`（注入 beforeToolCall + 过滤
// permissionRequest 消息）和 `agent-manager.ts`（bridge / 广播 / 落库编排）共用。
//
// 关键设计：本模块**完全不认识** skill / grant / bridge / 广播等具体机制。
// - 「某个工具是否需要授权、要展示什么、如何持久化授权」由 `ToolGate` 抽象，
//   具体实现（如 run_skill 的 policy）留在各自的工具文件里。
// - 「如何向用户征求决策」由注入的 `RequestDecisionFn` 抽象，真正的
//   插入消息 / 弹卡片 / 等待 / 回写 / 广播在 agent-manager 一侧实现。
// 这样未来要给 chrome_api / execute_js 等加执行前授权，只需新增一个 ToolGate
// 注册进数组，本模块零改动。
//
// 公共 API 统一放在文件末尾（见底部「Public API」块）。

import type {
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@earendil-works/pi-agent-core';
import { t } from '@/lib/i18n';
import { assertNever } from '@/lib/utils';
import { parsePermission } from '@/lib/tools/permissions';
import { CHROME_API_WHITELIST } from '@/lib/tools/chrome-api-whitelist';

// ─── 决策与请求载荷 ───

/**
 * 用户对一次授权请求的最终决策：
 * - `once`：仅本次允许，放行但不持久化。
 * - `always`：始终允许此工具目标，放行并持久化授权。
 * - `denied`：用户点了「拒绝」按钮——明确否决。
 * - `dismissed`：用户没回应卡片、直接发了新消息——隐式未授权。
 *
 * `denied` 与 `dismissed` 都会阻止本次执行，区别只在给 LLM 的 reason 文案
 * 与 UI 卡片终态（拒绝=按钮高亮 / 发消息=整卡置灰），见 §UI（子任务 7）。
 */
type PermissionDecision = 'once' | 'always' | 'denied' | 'dismissed';

/**
 * 一次工具执行前的授权请求载荷（展示用）。
 * - `title`：已由对应 policy 渲染成成句文案（如「技能 X 想要执行 Y」）。
 * - `permissions`：保持原始 token（如 `chrome.cookies` / `bgFetch:...`），
 *   由 UI 经 `describePermission` 实时渲染成人话——固定词汇表，generic UI 自己掌握。
 */
interface PermissionRequest {
  toolCallId: string;
  toolName: string;
  title: string;
  permissions: string[];
}

/**
 * policy（ToolGate.check）提供的「展示信息」——只含与具体工具相关的字段。
 * 工具调用的身份（toolCallId / toolName）由通用门禁从 `context.toolCall`
 * 派生后补全，policy 拿不到也不该编造这些 id。
 */
type PermissionRequestDetails = Pick<PermissionRequest, 'title' | 'permissions'>;

// ─── permissionRequest 自定义消息 ───

/**
 * 授权请求消息：当一个被 gate 拦截的工具在执行前需要授权时，被插入
 * `agent.state.messages`，跟随正常的持久化 / 广播 / UI 渲染管线。仿照
 * `compactionSummary`——`convertToLlm` 会把它过滤掉，不发给 provider，
 * 因此不破坏 assistant(toolCall) ↔ toolResult 的相邻性。
 *
 * 落点天然正确：`beforeToolCall` 触发时，请求该工具的 assistant 消息已经
 * push 进 messages，toolResult 还没生成，所以这条消息正好落在两者之间。
 *
 * `decision` 从 `pending` 起步；用户决策后由编排层回写为最终值，再次广播 +
 * 落库。转录里因此留下一条永久的授权审计记录。
 */
interface PermissionRequestMessage extends PermissionRequest {
  role: 'permissionRequest';
  decision: 'pending' | PermissionDecision;
  timestamp: number;
}

// 通过 pi-agent-core 官方的 declaration merging 扩展点，把 permissionRequest
// 注入 `AgentMessage` union，使其成为合法的 AgentMessage 成员（类型安全）。
declare module '@earendil-works/pi-agent-core' {
  interface CustomAgentMessages {
    permissionRequest: PermissionRequestMessage;
  }
}

/** 构造一条 pending 的授权请求消息。 */
function createPermissionRequestMessage(
  request: PermissionRequest,
): PermissionRequestMessage {
  return {
    role: 'permissionRequest',
    ...request,
    decision: 'pending',
    timestamp: Date.now(),
  };
}

/** 类型守卫：判断一条消息是否为 permissionRequest。 */
function isPermissionRequest(
  msg: { role: string },
): msg is PermissionRequestMessage {
  return msg.role === 'permissionRequest';
}

// ─── 权限 token → 人话解释 ───

/**
 * 11 个 chrome.* 白名单 namespace 各自的 i18n key。类型 `Record<keyof typeof
 * CHROME_API_WHITELIST, string>` 把它锚定到白名单（唯一真值源）——白名单新增
 * namespace 却忘了在此补文案，会**编译失败**，而不是静默掉进 fallback。
 */
const CHROME_NS_I18N = {
  tabs: 'chat.permission.perm.chromeTabs',
  windows: 'chat.permission.perm.chromeWindows',
  alarms: 'chat.permission.perm.chromeAlarms',
  webNavigation: 'chat.permission.perm.chromeWebNavigation',
  bookmarks: 'chat.permission.perm.chromeBookmarks',
  history: 'chat.permission.perm.chromeHistory',
  cookies: 'chat.permission.perm.chromeCookies',
  topSites: 'chat.permission.perm.chromeTopSites',
  sessions: 'chat.permission.perm.chromeSessions',
  downloads: 'chat.permission.perm.chromeDownloads',
  notifications: 'chat.permission.perm.chromeNotifications',
} as const satisfies Record<keyof typeof CHROME_API_WHITELIST, string>;

/**
 * 把单个权限 token 渲染成给用户看的人话解释。词汇与解析统一走
 * `lib/tools/permissions.ts`（沙箱能力词汇），本函数只负责「判别联合 → i18n」。
 * 无法解析的 token（malformed / 未知）原样回显，至少让用户看到 token 本身。
 *
 * switch 用穷尽检查（assertNever）：将来新增一种权限 kind 必须在此补人话，
 * 漏掉则编译失败。chrome 分支查 `CHROME_NS_I18N`（白名单驱动），白名单外的
 * namespace 走带占位的 fallback。
 *
 * 在 UI 渲染时调用——i18n 实时生效，不在后台冻结成字符串。
 */
function describePermission(permission: string): string {
  const perm = parsePermission(permission);
  if (!perm) return permission;

  switch (perm.kind) {
    case 'pageExecuteJs':
      return t('chat.permission.perm.pageExecuteJs');
    case 'vfsRead':
      return t('chat.permission.perm.vfsRead');
    case 'vfsWrite':
      return t('chat.permission.perm.vfsWrite');
    case 'bgFetch':
      return perm.pattern
        ? t('chat.permission.perm.bgFetchPattern', [perm.pattern])
        : t('chat.permission.perm.bgFetchAny');
    case 'chrome': {
      // parsePermission 只校验 token **形状**，不查白名单成员资格——形状合法的
      // `chrome.foo` / 继承名 `chrome.toString` 都能走到这里。hasOwnProperty 同时
      // 完成两件事：区分「已配文案的 namespace」与 fallback，并挡掉继承属性脏数据。
      if (Object.prototype.hasOwnProperty.call(CHROME_NS_I18N, perm.namespace)) {
        return t(CHROME_NS_I18N[perm.namespace as keyof typeof CHROME_API_WHITELIST]);
      }
      return t('chat.permission.perm.chromeFallback', [perm.namespace]);
    }
    default:
      return assertNever(perm);
  }
}

// ─── 给 LLM 的阻断 reason（LLM-facing，硬编码英文，不进 i18n）───

/** 用户明确点「拒绝」时回给 LLM 的 error tool result 文本。 */
const PERMISSION_DENIED_REASON =
  'The user explicitly denied permission for this action. Do not retry the same call; ' +
  'consider an alternative approach or ask the user how to proceed.';

/** 用户未授权、直接发了新消息时回给 LLM 的 error tool result 文本。 */
const PERMISSION_DISMISSED_REASON =
  'The user did not grant permission and sent a new instruction instead. ' +
  'Abandon this call and handle the new message.';

// ─── 通用门禁 ───

/**
 * 一个工具的授权策略。每个需要执行前授权的工具实现并导出一个 `ToolGate`，
 * 注册进 `createPermissionGate` 的数组。policy 自己掌握「读什么、查哪份授权、
 * 怎么持久化」，对通用门禁不透明。
 */
interface ToolGate {
  /** 该 gate 拦截的工具名，对齐 `AgentTool.name` / `toolCall.name`。 */
  toolName: string;
  /**
   * 执行前检查。`needsGrant=false` 直接放行（无需授权或已授权）；
   * `needsGrant=true` 时必须附带要展示给用户的 `request`（仅含 title /
   * permissions 这类展示字段；调用身份由通用门禁从 context 补全）。
   * check 自己负责读取已有授权（grant）并判定是否仍然有效。
   */
  check(args: unknown): Promise<{ needsGrant: boolean; request?: PermissionRequestDetails }>;
  /** 用户选「始终允许」时持久化授权。`once` / `denied` / `dismissed` 不调用。 */
  persistGrant(args: unknown): Promise<void>;
}

/**
 * 向用户征求一次授权决策。由编排层（agent-manager）注入：真正的实现会
 * 插入 permissionRequest 消息 → 广播 pending → await 用户在卡片上的点击 →
 * 回写消息 decision → 广播 resolved，最后把决策返回这里。必须 honor signal
 * （用户点停止 / 该会话被销毁时应尽快以某个终态结束）。
 */
type RequestDecisionFn = (
  request: PermissionRequest,
  signal?: AbortSignal,
) => Promise<PermissionDecision>;

/** `beforeToolCall` 钩子签名（pi-agent-core 约定）。 */
type BeforeToolCallHook = (
  context: BeforeToolCallContext,
  signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined>;

/**
 * 构造一个 `beforeToolCall` 钩子函数。pi-agent-core 在「工具参数已校验、
 * execute() 之前」调用它；返回 `{ block: true, reason }` 阻止执行并向 LLM
 * 回一条 error tool result，返回 `undefined` 放行。
 *
 * 流程：按 `toolCall.name` 找 gate → 无则放行 → 有则 `check` →
 * 不需授权则放行 → 需授权则 `requestDecision` 等用户 →
 * deny/dismiss 阻断（各自 reason）/ once 放行 / always 持久化后放行。
 *
 * preflight 在 agent loop 里是顺序执行的（即使 parallel 工具批次），所以
 * 任意时刻最多一个授权请求在途——这是 UI 单待决模型成立的前提。
 */
function createPermissionGate(
  gates: ToolGate[],
  requestDecision: RequestDecisionFn,
): BeforeToolCallHook {
  const byName = new Map(gates.map((g) => [g.toolName, g]));

  return async (context, signal) => {
    const gate = byName.get(context.toolCall.name);
    // 无 gate → 放行
    if (!gate) return undefined;

    const { needsGrant, request: details } = await gate.check(context.args);
    // 无需授权 / 已授权 → 放行
    if (!needsGrant) return undefined;

    // 安全边界：声称需要授权却没给展示信息，是 gate 实现的 bug。
    // 绝不 fail open——抛错让框架转成 error tool result，工具不执行。
    if (!details) {
      throw new Error(
        `Permission gate for "${context.toolCall.name}" reported needsGrant but returned no request.`,
      );
    }

    // 身份由通用门禁从受信的 context.toolCall 派生，policy 不参与。
    const request: PermissionRequest = {
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      title: details.title,
      permissions: details.permissions,
    };

    const decision = await requestDecision(request, signal);

    if (decision === 'denied') {
      return { block: true, reason: PERMISSION_DENIED_REASON };
    }
    if (decision === 'dismissed') {
      return { block: true, reason: PERMISSION_DISMISSED_REASON };
    }
    if (decision === 'always') {
      await gate.persistGrant(context.args);
    }
    // once / always → 放行
    return undefined;
  };
}

// ─── Public API ───

export type {
  PermissionDecision,
  PermissionRequest,
  PermissionRequestDetails,
  PermissionRequestMessage,
  RequestDecisionFn,
  BeforeToolCallHook,
  ToolGate,
};

export {
  // permissionRequest 自定义消息
  createPermissionRequestMessage,
  isPermissionRequest,
  // 权限说明
  describePermission,
  // LLM-facing 阻断 reason
  PERMISSION_DENIED_REASON,
  PERMISSION_DISMISSED_REASON,
  // 通用门禁
  createPermissionGate,
};

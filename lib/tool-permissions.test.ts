import { describe, it, expect, vi } from 'vitest';
import {
  createPermissionGate,
  describePermission,
  PERMISSION_DENIED_REASON,
  PERMISSION_DISMISSED_REASON,
  type ToolGate,
  type PermissionDecision,
  type PermissionRequest,
  type PermissionRequestDetails,
  type RequestDecisionFn,
} from '@/lib/tool-permissions';
import { CHROME_API_WHITELIST } from '@/lib/tools/chrome-api-whitelist';
import type { BeforeToolCallContext } from '@earendil-works/pi-agent-core';

// describePermission 依赖 `t`，而 fakeBrowser 不实现 chrome.i18n.getMessage。
// Mock 成「回显 key（+ 拼接占位参数）」，这样能直接断言「选了哪个 key、pattern
// 有没有拼进去」——测的是路由逻辑本身，不耦合具体译文（译文改了不该让测试挂）。
vi.mock('@/lib/i18n', () => ({
  t: (key: string, subs?: unknown[]) => (subs && subs.length ? `${key}|${subs.join(',')}` : key),
}));

// 构造一个最小 BeforeToolCallContext —— gate 只读 toolCall.name / toolCall.id / args。
function ctx(name: string, id: string, args: unknown): BeforeToolCallContext {
  return {
    toolCall: { type: 'toolCall', id, name, arguments: args },
    args,
    // 下面两个字段 gate 不读，给占位以满足类型。
    assistantMessage: { role: 'assistant', content: [] },
    context: { systemPrompt: '', messages: [], tools: [] },
  } as unknown as BeforeToolCallContext;
}

// 一个可配置的假 ToolGate。
function fakeGate(
  toolName: string,
  check: ToolGate['check'],
  persistGrant: ToolGate['persistGrant'] = vi.fn(async () => {}),
): ToolGate {
  return { toolName, check, persistGrant };
}

const REQUEST: PermissionRequestDetails = {
  title: 'Skill x wants to run y',
  permissions: ['chrome.cookies'],
};

describe('createPermissionGate — 放行 / 阻断分流', () => {
  it('无匹配 gate → 放行（返回 undefined），不调 requestDecision', async () => {
    const requestDecision = vi.fn<RequestDecisionFn>(async () => 'once');
    const gate = createPermissionGate(
      [fakeGate('run_skill', async () => ({ needsGrant: true, request: REQUEST }))],
      requestDecision,
    );
    const result = await gate(ctx('other_tool', 'c1', {}));
    expect(result).toBeUndefined();
    expect(requestDecision).not.toHaveBeenCalled();
  });

  it('gate.check 说无需授权 → 放行，不弹窗', async () => {
    const requestDecision = vi.fn(async () => 'once' as PermissionDecision);
    const gate = createPermissionGate(
      [fakeGate('run_skill', async () => ({ needsGrant: false }))],
      requestDecision,
    );
    const result = await gate(ctx('run_skill', 'c1', {}));
    expect(result).toBeUndefined();
    expect(requestDecision).not.toHaveBeenCalled();
  });

  it('需授权 + 用户 once → 放行，不持久化', async () => {
    const persistGrant = vi.fn(async () => {});
    const requestDecision = vi.fn(async () => 'once' as PermissionDecision);
    const gate = createPermissionGate(
      [fakeGate('run_skill', async () => ({ needsGrant: true, request: REQUEST }), persistGrant)],
      requestDecision,
    );
    const result = await gate(ctx('run_skill', 'c1', {}));
    expect(result).toBeUndefined();
    expect(requestDecision).toHaveBeenCalledTimes(1);
    expect(persistGrant).not.toHaveBeenCalled();
  });

  it('需授权 + 用户 always → 放行，且 persistGrant 被调用', async () => {
    const persistGrant = vi.fn(async () => {});
    const requestDecision = vi.fn(async () => 'always' as PermissionDecision);
    const gate = createPermissionGate(
      [fakeGate('run_skill', async () => ({ needsGrant: true, request: REQUEST }), persistGrant)],
      requestDecision,
    );
    const result = await gate(ctx('run_skill', 'c1', { skill: 's' }));
    expect(result).toBeUndefined();
    expect(persistGrant).toHaveBeenCalledTimes(1);
    // persistGrant 拿到的是原始 args，不是 request。
    expect(persistGrant).toHaveBeenCalledWith({ skill: 's' });
  });

  it('需授权 + 用户 denied → 阻断（block + 拒绝 reason），不持久化', async () => {
    const persistGrant = vi.fn(async () => {});
    const requestDecision = vi.fn(async () => 'denied' as PermissionDecision);
    const gate = createPermissionGate(
      [fakeGate('run_skill', async () => ({ needsGrant: true, request: REQUEST }), persistGrant)],
      requestDecision,
    );
    const result = await gate(ctx('run_skill', 'c1', {}));
    expect(result).toEqual({ block: true, reason: PERMISSION_DENIED_REASON });
    expect(persistGrant).not.toHaveBeenCalled();
  });

  it('需授权 + 用户 dismissed（发消息绕过）→ 阻断（block + dismissed reason）', async () => {
    const requestDecision = vi.fn(async () => 'dismissed' as PermissionDecision);
    const gate = createPermissionGate(
      [fakeGate('run_skill', async () => ({ needsGrant: true, request: REQUEST }))],
      requestDecision,
    );
    const result = await gate(ctx('run_skill', 'c1', {}));
    expect(result).toEqual({ block: true, reason: PERMISSION_DISMISSED_REASON });
  });
});

describe('createPermissionGate — 安全不变式', () => {
  it('needsGrant 为 true 却没给 request → 失败关闭（throw），绝不 fail open', async () => {
    const requestDecision = vi.fn(async () => 'once' as PermissionDecision);
    const gate = createPermissionGate(
      // 故意的 gate 实现 bug：声称需要授权却不给 request。
      [fakeGate('run_skill', async () => ({ needsGrant: true }))],
      requestDecision,
    );
    await expect(gate(ctx('run_skill', 'c1', {}))).rejects.toThrow(/needsGrant but returned no request/);
    expect(requestDecision).not.toHaveBeenCalled();
  });

  it('身份（toolCallId / toolName）由 context 派生，policy 不参与', async () => {
    let seen: { toolCallId: string; toolName: string } | null = null;
    const requestDecision = vi.fn<RequestDecisionFn>(async (req: PermissionRequest) => {
      seen = { toolCallId: req.toolCallId, toolName: req.toolName };
      return 'once';
    });
    const gate = createPermissionGate(
      [fakeGate('run_skill', async () => ({ needsGrant: true, request: REQUEST }))],
      requestDecision,
    );
    await gate(ctx('run_skill', 'call-42', {}));
    expect(seen).toEqual({ toolCallId: 'call-42', toolName: 'run_skill' });
  });

  it('hook 收到的 AbortSignal 原样转交给 requestDecision', async () => {
    // 取消契约：用户点停止 / 会话销毁靠这个 signal 让 bridge 尽快结束。
    // 若这里漏传 signal，停止时会卡在一个永不结束的授权请求后面。
    let seenSignal: AbortSignal | undefined;
    const requestDecision = vi.fn<RequestDecisionFn>(async (_req, signal) => {
      seenSignal = signal;
      return 'once';
    });
    const gate = createPermissionGate(
      [fakeGate('run_skill', async () => ({ needsGrant: true, request: REQUEST }))],
      requestDecision,
    );
    const controller = new AbortController();
    await gate(ctx('run_skill', 'c1', {}), controller.signal);
    expect(seenSignal).toBe(controller.signal);
  });

  it('always 分支 persistGrant 抛错 → 向上传播（失败关闭，不静默放行）', async () => {
    // persistGrant 由 gate policy 实现；门禁层不吞它的异常。本测试钉住「门禁
    // 不 catch-and-allow」这一行为——若将来要改成「持久化失败仍放行」，会在这里
    // 显式失败，提醒重新评估安全语义。
    const persistGrant = vi.fn(async () => {
      throw new Error('storage write failed');
    });
    const requestDecision = vi.fn<RequestDecisionFn>(async () => 'always');
    const gate = createPermissionGate(
      [fakeGate('run_skill', async () => ({ needsGrant: true, request: REQUEST }), persistGrant)],
      requestDecision,
    );
    await expect(gate(ctx('run_skill', 'c1', {}))).rejects.toThrow(/storage write failed/);
  });
});

describe('describePermission — 权限 token → 人话路由', () => {
  it('已知 token 路由到对应的 i18n key', () => {
    expect(describePermission('chrome.cookies')).toBe('chat.permission.perm.chromeCookies');
    expect(describePermission('page.executeJs')).toBe('chat.permission.perm.pageExecuteJs');
    expect(describePermission('vfs.read')).toBe('chat.permission.perm.vfsRead');
    expect(describePermission('vfs.write')).toBe('chat.permission.perm.vfsWrite');
    expect(describePermission('bgFetch')).toBe('chat.permission.perm.bgFetchAny');
  });

  it('11 个白名单 chrome namespace 各有专属 key（由白名单驱动，穷举）', () => {
    // 用 CHROME_API_WHITELIST 当事实来源：任何一个 namespace 落到 fallback
    // （即文案与 namespace 名不专属对应）都会在这里失败，避免漏配。
    const expected: Record<string, string> = {
      tabs: 'chromeTabs',
      windows: 'chromeWindows',
      alarms: 'chromeAlarms',
      webNavigation: 'chromeWebNavigation',
      bookmarks: 'chromeBookmarks',
      history: 'chromeHistory',
      cookies: 'chromeCookies',
      topSites: 'chromeTopSites',
      sessions: 'chromeSessions',
      downloads: 'chromeDownloads',
      notifications: 'chromeNotifications',
    };
    const whitelistNamespaces = Object.keys(CHROME_API_WHITELIST).sort();
    // 守卫：白名单若新增 namespace 而这里没补 expected，立即失败。
    expect(whitelistNamespaces).toEqual(Object.keys(expected).sort());
    for (const [ns, suffix] of Object.entries(expected)) {
      expect(describePermission(`chrome.${ns}`)).toBe(`chat.permission.perm.${suffix}`);
    }
  });

  it('bgFetch:<pattern> 路由到 pattern key 并把 pattern 拼进占位', () => {
    expect(describePermission('bgFetch:https://api.example.com/*')).toBe(
      'chat.permission.perm.bgFetchPattern|https://api.example.com/*',
    );
  });

  it('空 bgFetch: pattern 落到原样回显（不伪装成空作用域说明）', () => {
    expect(describePermission('bgFetch:')).toBe('bgFetch:');
  });

  it('白名单外的 chrome.<ns> → fallback key（带 ns 占位）', () => {
    expect(describePermission('chrome.notInWhitelist')).toBe(
      'chat.permission.perm.chromeFallback|notInWhitelist',
    );
  });

  it('完全未知 token → 原样回显', () => {
    expect(describePermission('totally.unknown')).toBe('totally.unknown');
  });
});

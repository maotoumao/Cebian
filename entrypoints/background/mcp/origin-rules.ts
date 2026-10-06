// 去掉扩展发往 MCP 服务器的请求里的 Origin 头。
//
// 扩展后台的 fetch 会被浏览器自动带上 `Origin: chrome-extension://<id>`，代码既改不了也删
// 不掉（forbidden header）。MCP 规范要求服务端校验 Origin 以防 DNS rebinding，Cloudflare 等
// 服务器因此直接拒绝扩展（#81）。这里用 declarativeNetRequest 会话规则，只对「本扩展发起、
// 且发往已启用 MCP 服务器」的请求删掉 Origin，让扩展像 Node / 桌面客户端一样访问；网页发出
// 的请求、扩展发往其它地址（如 LLM provider）的请求都不受影响。
//
// 会话规则在浏览器重启 / 扩展重载后清空，SW 每次启动都要重建；配置变更时整体重建（幂等）。
// 本扩展的会话规则只由本模块管理，重建时清掉全部旧规则。MCP 连接会等规则同步完再发出
// （MCPManager 的 connect gate），否则新增服务器时会话抢先连接，仍会被拒。
//
// Firefox 上这些规则是否作用于扩展自身的请求尚未验证；不生效时行为与之前一致。

import { mcpServers, type MCPServerConfig } from '@/lib/persistence/storage';
import { getMCPManager } from '@/lib/mcp/manager';

type Rule = chrome.declarativeNetRequest.Rule;

/**
 * 每个启用服务器的 origin 生成一条删 Origin 的规则（同 origin 去重）。按 origin 而不是完整
 * URL 匹配：SSE 传输会把消息 POST 到服务器下发的另一个路径。非 http(s) 或非法 URL 跳过；
 * 主机名含 `*`（含编码后的 `%2a`）也跳过——它在 urlFilter 里是通配符，会把规则扩到任意主机。
 *
 * `extensionHost` 是扩展自身页面 URL 的主机名（请求的 initiator）：Chrome 上即扩展 id，
 * Firefox 上是每次安装生成的内部 UUID，而不是 `runtime.id`。
 */
function buildOriginRules(servers: MCPServerConfig[], extensionHost: string): Rule[] {
  const origins = new Set<string>();
  for (const server of servers) {
    if (!server.enabled) continue;
    let url: URL;
    try {
      url = new URL(server.transport.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (url.host.includes('*')) continue;
    origins.add(url.origin);
  }
  return Array.from(origins, (origin, index) => ({
    id: index + 1,
    priority: 1,
    condition: {
      urlFilter: `|${origin}/`,
      initiatorDomains: [extensionHost],
      resourceTypes: [
        'xmlhttprequest' as chrome.declarativeNetRequest.ResourceType,
        'other' as chrome.declarativeNetRequest.ResourceType,
      ],
    },
    action: {
      type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: [
        { header: 'origin', operation: 'remove' as chrome.declarativeNetRequest.HeaderOperation },
      ],
    },
  }));
}

/** 按当前配置整体重建会话规则。浏览器不支持 DNR 时跳过，调用失败时只告警，都不影响其它功能。 */
async function syncOriginRules(): Promise<void> {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr?.updateSessionRules) return;
  try {
    const [servers, existing] = await Promise.all([mcpServers.getValue(), dnr.getSessionRules()]);
    await dnr.updateSessionRules({
      removeRuleIds: existing.map((rule) => rule.id),
      addRules: buildOriginRules(servers, new URL(chrome.runtime.getURL('/')).hostname),
    });
  } catch (err) {
    console.warn('[mcp] failed to sync origin rules:', err);
  }
}

/**
 * 启动时同步一次，之后每次 MCP 配置变更都重建。同步串行执行：两次重建交错会让后一次删掉
 * 前一次刚加的规则，或因 id 冲突失败；每次执行时都读最新配置，所以排队不会用到旧值。
 *
 * MCP 连接前等队列排空（`setConnectGate`）。本函数在 SW 启动时同步调用，它的 watch 先于
 * MCPManager 懒加载时注册的 watch，同一次配置变更里重建总是先入队，会话随后的连接能等到它。
 * `syncOriginRules` 从不 reject，gate 也就不会让连接失败。
 */
function setupMcpOriginRules(): void {
  let queue = Promise.resolve();
  const schedule = () => {
    queue = queue.then(syncOriginRules);
  };
  schedule();
  mcpServers.watch(schedule);
  getMCPManager().setConnectGate(() => queue);
}

// ─── 公开 API ───

// buildOriginRules 仅为同目录单测导出
export { setupMcpOriginRules, buildOriginRules };

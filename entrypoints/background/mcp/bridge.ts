// mcp 能力：background 侧到 `lib/mcp/manager` 的桥。承接两个 wire surface ——
// 端口侧的 `mcp_read_resource`（MCP App iframe 拉 `ui://...` 资源）与 sendMessage
// 侧的 `mcp_status`（设置页一次性状态查询）。文件名取 bridge 而非 client-handlers，
// 因为它不只处理端口消息。

import { getMCPManager } from '@/lib/mcp/manager';
import { registerClientHandlers, type ClientHandlerMap } from '../ipc/client-router';
import { post } from '../ipc/port-registry';

const mcpClientHandlers: ClientHandlerMap = {
  // Fetch a `ui://...` UI resource for an MCP App iframe. Reply goes
  // back to the requesting port only (not broadcast) — each iframe
  // owns its own pending read keyed by `requestId`. Errors are
  // classified into two coarse buckets so the sidepanel can render
  // an appropriate fallback without parsing strings.
  async mcp_read_resource(port, msg) {
    const { requestId, serverId, uri } = msg;
    const manager = getMCPManager();
    try {
      // Pre-check disambiguates "server gone" from "fetch failed".
      // Without it, the same `Error("MCP server disabled: ...")` from
      // MCPManager would mask both cases.
      const enabled = await manager.getEnabledServers();
      if (!enabled.some(s => s.id === serverId)) {
        post(port, {
          type: 'mcp_resource_result',
          requestId,
          error: {
            code: 'server_unavailable',
            message: `MCP server is not enabled or no longer registered`,
          },
        });
        return;
      }
      const result = await manager.readResource(serverId, uri);
      post(port, { type: 'mcp_resource_result', requestId, result });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      // Re-map the narrow race where the user disables / removes the
      // server between the pre-check and `readResource`. The MCPManager
      // throws `MCP server disabled: ...` / `MCP server not registered: ...`
      // for these — string-match is brittle but matches the established
      // error-classification style.
      const isServerGone =
        message.startsWith('MCP server disabled:') ||
        message.startsWith('MCP server not registered:');
      post(port, {
        type: 'mcp_resource_result',
        requestId,
        error: {
          code: isServerGone ? 'server_unavailable' : 'fetch_failed',
          message,
        },
      });
    }
  },
};

/**
 * 注册端口侧 handler，并挂上 sendMessage 侧的 `mcp_status` 一次性问答。
 * 在 `index.ts` 启动序列里、`setupPortRegistry()` 之前同步调用。
 */
function setupMcpBridge(): void {
  registerClientHandlers(mcpClientHandlers);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'mcp_status') return false;
    // One-shot status query for the Settings UI. Returns a map keyed by
    // server id, only for currently-enabled servers (disabled ones never
    // connect, so the UI handles them via `!server.enabled` first).
    void (async () => {
      try {
        const mgr = getMCPManager();
        const servers = await mgr.getEnabledServers();
        const out: Record<string, { connected: boolean; breaker: string }> = {};
        for (const s of servers) {
          const st = await mgr.getStatus(s.id);
          if (st) out[s.id] = { connected: st.connected, breaker: st.breaker };
        }
        sendResponse(out);
      } catch (err) {
        console.warn('[background] mcp_status query failed:', err);
        sendResponse({});
      }
    })();
    return true; // async response
  });
}

// ─── 公开 API ───

export { setupMcpBridge, mcpClientHandlers };

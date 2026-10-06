import { useEffect, useState } from 'react';
import type { ServerStatus } from '@/lib/mcp/manager';

/** 后台 `mcp_status` 返回的单个服务器状态，与 `MCPManager.getStatus` 同一形状。 */
export type MCPStatusInfo = ServerStatus;

export type MCPStatusMap = Record<string, MCPStatusInfo>;

const POLL_MS = 5_000;

/**
 * 轮询后台 SW 拿各 MCP 服务器的实时状态（连接、熔断器、最近一次错误）。
 *
 * Status is in-memory in the background, so a one-shot `chrome.runtime.sendMessage`
 * round-trip works fine — no port subscription needed. Disabled servers are
 * absent from the result map.
 *
 * Intended to be called per-card; if the server count grows large, lift the
 * hook into the parent section and pass the map down.
 */
export function useMCPStatus(): MCPStatusMap {
  const [status, setStatus] = useState<MCPStatusMap>({});

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const resp = (await chrome.runtime.sendMessage({ type: 'mcp_status' })) as MCPStatusMap | undefined;
        if (!cancelled && resp) setStatus(resp);
      } catch {
        // SW may be torn down; next interval retries.
      }
    };

    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return status;
}

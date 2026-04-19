import { useEffect, useState } from 'react';

export interface MCPStatusInfo {
  connected: boolean;
  breaker: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
}

export type MCPStatusMap = Record<string, MCPStatusInfo>;

const POLL_MS = 5_000;

/**
 * Polls the background SW for live MCP server status (connection + breaker).
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

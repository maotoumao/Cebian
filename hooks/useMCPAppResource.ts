import { useEffect, useState } from 'react';
import {
  mcpAppResourceChannel,
  MCPResourceError,
  type MCPResourceErrorCode,
} from '@/lib/mcp/sidepanel-channel';
import type { MCPResourceContents } from '@/lib/mcp/client';

/**
 * Sidepanel React hook that resolves an MCP App `ui://` resource for
 * inline iframe rendering.
 *
 * Wraps the singleton `mcpAppResourceChannel` (which owns dedup +
 * cache) and exposes the typical loading / ready / error tri-state to
 * components. The retry counter forces a fresh fetch when the user
 * clicks a retry button — the channel evicts rejected promises from
 * cache so bumping the counter is enough to re-issue.
 *
 * Returns a `retry` callback the consumer can wire to a button; calling
 * it from `loading` state is a no-op (we're not going to abort an
 * in-flight fetch and start over).
 */

export interface MCPAppResourceState {
  status: 'loading' | 'ready' | 'error';
  resource?: MCPResourceContents;
  errorCode?: MCPResourceErrorCode;
  errorMessage?: string;
  /** Force a refetch; safe to call repeatedly. */
  retry: () => void;
}

export function useMCPAppResource(
  serverId: string,
  resourceUri: string,
): MCPAppResourceState {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Omit<MCPAppResourceState, 'retry'>>({
    status: 'loading',
  });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    mcpAppResourceChannel.fetch(serverId, resourceUri).then(
      (resource) => {
        if (cancelled) return;
        setState({ status: 'ready', resource });
      },
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof MCPResourceError) {
          setState({ status: 'error', errorCode: err.code, errorMessage: err.message });
        } else {
          setState({
            status: 'error',
            errorCode: 'fetch_failed',
            errorMessage: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
    return () => { cancelled = true; };
  }, [serverId, resourceUri, attempt]);

  return {
    ...state,
    retry: () => setAttempt((n) => n + 1),
  };
}

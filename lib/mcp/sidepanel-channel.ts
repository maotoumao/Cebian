// Sidepanel-side channel for MCP App `ui://` resource fetches.
//
// Pattern mirrors `lib/recorder/sidepanel-channel.ts`: the port itself is
// owned by `useBackgroundAgent`; this module is a tiny request/response
// bridge so any component or hook can ask the background "fetch the HTML
// for this resource URI" without coupling to the agent hook's internals.
//
// ## What this module does
//
//   - Holds an in-memory cache keyed by `(serverId, resourceUri)` so the
//     same UI resource is fetched at most once per sidepanel page-load.
//     A page reload (or service-worker tear-down on the other side)
//     forces a refetch, which is the desired "always-latest" behaviour
//     agreed in the v1 plan.
//
//   - Dedups concurrent requests: two `<ToolCardWithUI>` instances for
//     the same `(server, uri)` mounting in the same tick share a single
//     in-flight `mcp_read_resource` round-trip.
//
//   - Surfaces server-side error codes verbatim. Callers (the
//     `useMCPAppResource` hook) decide how to render — typically
//     `server_unavailable` → "tool is offline" empty state,
//     `fetch_failed` → retry button.

import type { ClientMessage, ServerMessage } from '@/lib/protocol';
import type { MCPResourceContents } from './client';

/** Error codes the BG can return on `mcp_resource_result`. */
export type MCPResourceErrorCode = 'server_unavailable' | 'fetch_failed';

export class MCPResourceError extends Error {
  constructor(public readonly code: MCPResourceErrorCode, message: string) {
    super(message);
    this.name = 'MCPResourceError';
  }
}

type Pending = {
  resolve: (r: MCPResourceContents) => void;
  reject: (e: MCPResourceError) => void;
};

const pending = new Map<string, Pending>();
const cache = new Map<string, Promise<MCPResourceContents>>();
let portRef: chrome.runtime.Port | null = null;

function cacheKey(serverId: string, uri: string): string {
  // `::` is illegal in both UUIDs and `ui://` URIs (URIs use `://` not
  // `::`), so this delimiter is unambiguous.
  return `${serverId}::${uri}`;
}

export const mcpAppResourceChannel = {
  setPort(p: chrome.runtime.Port | null): void {
    if (portRef === p) return;
    portRef = p;
    // Drain pending on ANY port change — not just `p == null` — so a
    // hypothetical non-null → non-null swap (test rigs, future re-init
    // in the same hook lifecycle) doesn't leak zombie promises. In
    // normal flow the disconnect listener always interposes a
    // `setPort(null)` first, so this is the belt-and-braces line.
    for (const [, { reject }] of pending) {
      reject(new MCPResourceError('fetch_failed', 'Background connection lost'));
    }
    pending.clear();
  },

  /**
   * Resolve the BG's reply for a previously-issued `mcp_read_resource`.
   * Called by `useBackgroundAgent`'s switch — keeps message routing in
   * one place (we don't add a second `port.onMessage` listener here).
   */
  handleResult(msg: Extract<ServerMessage, { type: 'mcp_resource_result' }>): void {
    const p = pending.get(msg.requestId);
    if (!p) return;
    pending.delete(msg.requestId);
    if (msg.error) {
      p.reject(new MCPResourceError(msg.error.code, msg.error.message));
    } else if (msg.result) {
      p.resolve(msg.result);
    } else {
      // Should never happen — the BG always populates either `result`
      // or `error`. Defensive only.
      p.reject(new MCPResourceError('fetch_failed', 'Empty response from background'));
    }
  },

  /**
   * Fetch an MCP UI resource. Returns the cached promise on a hit so
   * concurrent renders of the same `(server, uri)` share one round-trip.
   *
   * A rejected promise is NOT cached: the eviction happens *inside* the
   * rejection path (before the error visibly settles) so a caller that
   * subscribes synchronously between the original rejection and a
   * separate cleanup microtask cannot observe a poisoned cache entry.
   *
   * We intentionally don't expose a separate `invalidate(key)` API for
   * v1 — the natural cache TTL is "until sidepanel reloads", which is
   * good enough for one-shot diagram rendering.
   */
  fetch(serverId: string, uri: string): Promise<MCPResourceContents> {
    const key = cacheKey(serverId, uri);
    const hit = cache.get(key);
    if (hit) return hit;

    const inner = (): Promise<MCPResourceContents> =>
      new Promise((resolve, reject) => {
        const port = portRef;
        if (!port) {
          reject(new MCPResourceError('fetch_failed', 'Background not connected'));
          return;
        }
        const requestId = crypto.randomUUID();
        pending.set(requestId, { resolve, reject });
        try {
          port.postMessage({
            type: 'mcp_read_resource',
            requestId,
            serverId,
            uri,
          } satisfies ClientMessage);
        } catch (err) {
          pending.delete(requestId);
          reject(new MCPResourceError(
            'fetch_failed',
            err instanceof Error ? err.message : String(err),
          ));
        }
      });

    const promise = (async () => {
      try {
        return await inner();
      } catch (err) {
        // Evict BEFORE re-throwing so external observers cannot see a
        // rejected cache entry even within the same microtask flush.
        cache.delete(key);
        throw err;
      }
    })();

    cache.set(key, promise);
    return promise;
  },
};

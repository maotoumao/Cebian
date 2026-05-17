import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppRenderer } from '@mcp-ui/client';
import type { McpUiResourceCsp } from '@modelcontextprotocol/ext-apps/app-bridge';
import { Loader2, AlertTriangle, RotateCw } from 'lucide-react';
import { t } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { useIsDark } from '@/hooks/useIsDark';
import { useMCPAppResource } from '@/hooks/useMCPAppResource';
import type { MCPAppDetails } from '@/lib/tools/mcp-tool';

/**
 * Inline-renders an MCP App iframe for a single tool-call result.
 *
 * Mirrors `ToolCard`'s visual shell (border + header bar) but the body
 * is an `<AppRenderer>` from `@mcp-ui/client` instead of plain text. The
 * AppRenderer creates the outer sandbox-proxy iframe internally, pointing
 * at our `entrypoints/mcp-app.sandbox/` page; that page in turn creates
 * the inner iframe via the SEP-1865 protocol.
 *
 * ## v1 scope
 *
 * Only `onOpenLink` is wired — the iframe can ask the host to open an
 * external URL (e.g. draw.io's "Open in editor" button). Every other
 * `On*` handler is intentionally omitted so the AppRenderer responds
 * with `MethodNotFound` for anything else (`tools/call`, `ui/message`,
 * etc.). This is the agreed v1 trade-off documented in the project plan.
 *
 * ## Cohesion
 *
 * Composition over inheritance: we share nothing structurally with the
 * existing `ToolCard` because the body shape diverges (iframe vs text)
 * and the lifecycle is fundamentally different (async resource fetch
 * vs ready-on-mount). Trying to share a header component would force
 * both call sites into a header-shape lowest common denominator that
 * neither needs.
 */

/** URL schemes the host will pass through to `chrome.tabs.create`. */
const SAFE_LINK_SCHEMES = ['https:', 'http:', 'mailto:'];

interface ToolCardWithUIProps {
  /** Display label, e.g. "draw.io / create_diagram". */
  label: string;
  /** Underlying MCP tool name (forwarded to AppRenderer for `tool` metadata). */
  toolName: string;
  /**
   * Server id sourced from the sibling `details.server.id` on the agent
   * tool result. Kept as a separate prop rather than in `MCPAppDetails`
   * to avoid duplicating identity inside the persisted payload — see the
   * comment on `MCPAppDetails` in `lib/tools/mcp-tool.ts`.
   */
  serverId: string;
  /** Server-attached MCP App payload from `details.mcpApp`. */
  mcpApp: MCPAppDetails;
}

export function ToolCardWithUI({ label, toolName, serverId, mcpApp }: ToolCardWithUIProps) {
  const isDark = useIsDark();
  const { status, resource, errorCode, errorMessage, retry } = useMCPAppResource(
    serverId,
    mcpApp.resourceUri,
  );

  // Track the body container's actual rendered width with a ResizeObserver
  // so we can hand it to the View via `hostContext.containerDimensions`.
  //
  // Without this, mcp-ui's AppRenderer falls back to the View's
  // self-reported "natural size" (per `ui/notifications/size-changed`).
  // For draw.io that natural size is ~320px, which leaves the rest of the
  // chat-message bubble visibly empty next to the diagram. Telling the
  // View "you have N pixels, use them" makes it re-layout to fill.
  //
  // We pass FIXED `width` (not `maxWidth`) so the View sets its root to
  // 100vw inside the iframe — see SEP-1865 "Container Dimensions". Height
  // stays flexible with a hard ceiling so a huge diagram doesn't eat the
  // whole chat scroll area.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    // Coalesce ResizeObserver callbacks to one per animation frame. A
    // continuous sidepanel-drag fires the observer per integer pixel,
    // which would otherwise produce hundreds of setState → re-render →
    // `host-context-changed` postMessage → diagram-relayout cycles in a
    // single drag. One per frame is what mcp-ui / the View can actually
    // consume; further debouncing trades responsiveness for nothing.
    let rafId: number | null = null;
    let pendingWidth = 0;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      // Math.floor: ignore sub-pixel jitter; integer-pixel changes are
      // still picked up.
      pendingWidth = Math.floor(entry.contentRect.width);
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setBodyWidth(pendingWidth);
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
    // The body div is unconditionally rendered across all statuses (the
    // children swap, the container doesn't), so the observer is attached
    // exactly once on mount and cleaned up on unmount.
  }, []);

  // The sandbox proxy URL is the MV3 sandbox page WXT generates from
  // `entrypoints/mcp-app.sandbox/`. AppRenderer creates an `<iframe
  // src={sandbox.url}>` internally; we never touch the outer iframe.
  //
  // `csp` is the critical bit: AppRenderer forwards it verbatim in the
  // `ui/notifications/sandbox-resource-ready` payload, which our sandbox
  // proxy then bakes into a `<meta http-equiv="Content-Security-Policy">`
  // for the inner iframe. Without this, the inner CSP defaults to                                                               
  // `script-src 'self' 'unsafe-inline'` and blocks every external
  // resource the app declared a need for — draw.io's bundled viewer is
  // entirely loaded from `https://viewer.diagrams.net`, so omitting the
  // CSP threading breaks rendering completely.
  //
  // Memo dep on `resource`: useMemo runs once with `resource=undefined`
  // (loading state, AppRenderer isn't mounted yet), then again with the
  // fetched resource (AppRenderer mounts now with the correct CSP).
  const sandboxConfig = useMemo(() => {
    // `_meta` is typed open at the protocol layer (`Record<string, unknown>`)
    // because the MCP spec reserves the namespace, not the schema. We
    // narrow it to the documented MCP Apps shape only at this consumer.
    // The sandbox proxy revalidates every domain through `DOMAIN_RE`
    // before it lands in a CSP directive, so this cast is type ergonomics,
    // not a security boundary.
    const uiMeta = resource?._meta?.ui as { csp?: McpUiResourceCsp } | undefined;
    return {
      url: new URL(chrome.runtime.getURL('/mcp-app.html')),
      ...(uiMeta?.csp ? { csp: uiMeta.csp } : {}),
    };
  }, [resource]);

  // Memoise hostContext so theme flips trigger a clean update (new ref
  // when isDark changes) but a normal re-render reuses the same ref.
  // `containerDimensions` is only attached once we have a measurement —
  // until then mcp-ui falls back to View's natural size, which is fine
  // for the brief window between mount and the first ResizeObserver tick.
  const hostContext = useMemo(() => ({
    theme: isDark ? ('dark' as const) : ('light' as const),
    ...(bodyWidth != null
      ? { containerDimensions: { width: bodyWidth, maxHeight: 600 } }
      : {}),
  }), [isDark, bodyWidth]);

  const handleOpenLink = useCallback(async ({ url }: { url: string }) => {
    try {
      const parsed = new URL(url);
      if (!SAFE_LINK_SCHEMES.includes(parsed.protocol)) {
        console.warn(`[mcp-app] blocked openLink to non-allowlisted scheme: ${parsed.protocol}`);
        return {};
      }
      await chrome.tabs.create({ url, active: true });
    } catch (err) {
      console.warn('[mcp-app] openLink failed:', err);
    }
    return {};
  }, []);

  // Retry only makes sense for transient `fetch_failed`. A
  // `server_unavailable` means the user disabled or removed the server
  // entirely — re-issuing the same request returns the same error.
  const canRetry = status === 'error' && errorCode === 'fetch_failed';

  return (
    <div className="border border-border rounded-lg overflow-hidden text-[0.8rem] min-w-0">
      {/* Header — mirrors ToolCard look but always visible (no collapse). */}
      <div className="flex items-center gap-2.5 px-3.5 py-2.5 bg-card">
        {status === 'loading' && <Loader2 className="size-4 text-primary animate-spin shrink-0" />}
        {status === 'error' && <AlertTriangle className="size-4 text-destructive shrink-0" />}
        {status === 'ready' && (
          <span className="size-1.5 rounded-full bg-success shrink-0" aria-hidden />
        )}
        <span className="flex-1 text-muted-foreground truncate">{label}</span>
      </div>

      {/* Body */}
      <div
        ref={bodyRef}
        // `[&_iframe]:w-full!` belt-and-braces: if mcp-ui's AppRenderer
        // sets `iframe.style.width` to a px value (it does this from
        // size-changed in flexible-width mode), our fixed-width
        // containerDimensions should already tell the View to fill,
        // but force the iframe element itself to 100% so we never see
        // a sub-container iframe leaving whitespace inside the card.
        className="border-t border-border bg-background [&_iframe]:w-full!"
      >
        {status === 'loading' && (
          // minHeight on the loading branch only — reserves vertical
          // space so the layout doesn't jump when the iframe mounts
          // (AppRenderer owns the iframe's own height via the spec's
          // `ui/notifications/size-changed` protocol; a floor on the
          // ready container would just create dead whitespace below).
          <div
            className="flex items-center justify-center text-xs text-muted-foreground/70"
            style={{ minHeight: 400 }}
          >
            {t('chat.mcpApp.loading')}
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-start gap-3 px-3.5 py-4">
            {/* Code-specific copy so non-English users don't see raw BG
                English error strings. The BG's `errorMessage` is still
                surfaced as a detail line for `fetch_failed` since the
                transport-level reason is often the diagnostic the user
                needs (DNS, refused, 4xx, etc.). */}
            <div className="text-xs text-destructive">
              {errorCode === 'server_unavailable'
                ? t('chat.mcpApp.errorServerUnavailable')
                : errorCode === 'fetch_failed'
                  ? t('chat.mcpApp.errorFetchFailed', [errorMessage ?? ''])
                  : t('chat.mcpApp.errorGeneric')}
            </div>
            {canRetry && (
              <Button variant="link" size="sm" onClick={retry} className="h-auto p-0 gap-1.5">
                <RotateCw className="size-3.5" />
                {t('chat.mcpApp.retry')}
              </Button>
            )}
          </div>
        )}

        {status === 'ready' && resource && (
          <AppRenderer
            toolName={toolName}
            sandbox={sandboxConfig}
            html={resource.text ?? ''}
            toolResourceUri={mcpApp.resourceUri}
            toolInput={mcpApp.toolInput}
            toolResult={mcpApp.toolResult}
            hostContext={hostContext}
            onOpenLink={handleOpenLink}
            // v1 TODO: AppRenderer surfaces protocol-level errors here
            // (e.g. iframe never sent `ui/notifications/initialized`,
            // unhandled JSON-RPC method). Once we add `onCallTool` /
            // `onMessage` in v2, surface these in the UI instead of
            // only console.warn — silent iframe failures will become a
            // diagnosis problem at that point.
            onError={(err) => console.warn('[mcp-app] AppRenderer error:', err)}
          />
        )}
      </div>
    </div>
  );
}


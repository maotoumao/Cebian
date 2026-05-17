/**
 * MCP Apps sandbox proxy — outer iframe layer.
 *
 * Implements the host-side wire protocol from MCP Apps SEP-1865, section
 * "Sandbox proxy":
 *
 *   1. Send `ui/notifications/sandbox-proxy-ready` to the host on load.
 *   2. Receive `ui/notifications/sandbox-resource-ready` from the host with
 *      `{ html, csp?, permissions? }` and create the inner iframe.
 *   3. Forward every other JSON-RPC message between host ↔ inner iframe,
 *      except `ui/notifications/sandbox-*` (reserved).
 *
 * This file runs inside an MV3 sandbox page (declared via WXT's
 * `*.sandbox/` entrypoint convention → manifest `sandbox.pages`). The
 * sandbox page has an opaque origin, so we can safely give the inner
 * iframe `allow-scripts allow-same-origin` — its "same origin" is our
 * opaque one, not the sidepanel's extension origin. That isolation is the
 * whole point of the double-iframe pattern.
 *
 * We deliberately do NOT depend on `@mcp-ui/client`'s vendored sandbox
 * proxy: the spec is small and host-controlled, and shipping our own keeps
 * the bundle on this side under ~250 lines with no transitive deps.
 *
 * ## Threat model
 *
 * The server-supplied HTML and `_meta.ui.{csp,permissions}` are treated as
 * untrusted. We harden three boundaries:
 *
 *   - CSP construction validates every domain string against a strict
 *     regex (no `;`, quotes, whitespace) so a malicious server can't inject
 *     extra directives that loosen the policy.
 *   - The CSP `<meta>` is placed in a fresh outer `<head>` we synthesise;
 *     the server's HTML is parked inside `<body>`. This sidesteps regex
 *     parsing of the served document and is unaffected by hostile
 *     comments / CDATA / attribute-embedded `<head>` decoys.
 *   - The `sandbox` attribute of the inner iframe is fixed at the spec
 *     minimum (`allow-scripts allow-same-origin`). We ignore any `sandbox`
 *     override the server might send via `sandbox-resource-ready`.
 */

// ─── Types ───────────────────────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc: '2.0';
  /** JSON-RPC 2.0 permits `null` on responses to malformed requests. */
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface CspMeta {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}

interface PermissionsMeta {
  camera?: object;
  microphone?: object;
  geolocation?: object;
  clipboardWrite?: object;
}

interface SandboxResourceReadyParams {
  html: string;
  /** Server-suggested sandbox token override — ignored in v1 (see threat
   *  model). Declared only so destructuring is type-safe. */
  sandbox?: string;
  csp?: CspMeta;
  permissions?: PermissionsMeta;
}

/** Fixed sandbox tokens for the inner iframe per SEP-1865 rule 2. */
const INNER_SANDBOX = 'allow-scripts allow-same-origin';

/**
 * Strict allowlist for CSP source values. Each entry must match one of:
 *   - origin: `https://host[:port]` or `http://host[:port]`
 *   - wildcard subdomain: `https://*.host[:port]`
 *   - scheme-only: `wss:` / `ws:` / `data:` / `blob:`
 *
 * Anything else — quotes, semicolons, whitespace, control chars — is
 * rejected so a server can't smuggle extra CSP directives.
 */
const DOMAIN_RE = /^(?:(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9.-]+(?::\d+)?|(?:wss?|data|blob):)$/i;

// ─── State ───────────────────────────────────────────────────────────

/** The single inner iframe, created on first `sandbox-resource-ready`. */
let innerIframe: HTMLIFrameElement | null = null;

// ─── Boot ────────────────────────────────────────────────────────────

// Tell the host we're alive and ready to receive a resource. The spec
// guarantees the host won't send `sandbox-resource-ready` before seeing
// this notification.
//
// targetOrigin `'*'`: the MV3 sandbox page has an opaque origin, can't
// access `chrome.*` to discover the host's `chrome-extension://<id>`
// origin, and any receiver running in an opaque-origin context wouldn't
// accept a posted non-null origin filter anyway. The real ACL is the
// receiver matching `event.source` against an unforgeable window ref.
window.parent.postMessage(
  {
    jsonrpc: '2.0',
    method: 'ui/notifications/sandbox-proxy-ready',
    params: {},
  } satisfies JsonRpcMessage,
  '*',
);

// ─── Message routing ─────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as JsonRpcMessage | null | undefined;
  if (!data || typeof data !== 'object' || data.jsonrpc !== '2.0') return;

  if (event.source === window.parent) {
    handleFromHost(data);
  } else if (innerIframe && event.source === innerIframe.contentWindow) {
    handleFromInner(data);
  }
  // Messages from any other source (e.g., a foreign iframe somewhere on
  // the page) are ignored. With opaque origins `event.origin` is `'null'`
  // for both sides and useless for ACL — `event.source` is the real check.
});

function handleFromHost(data: JsonRpcMessage): void {
  // Reserved namespace: never forward sandbox-* in either direction.
  // Spec rule 6 is symmetric; today only the host→proxy direction has
  // any real message (`sandbox-resource-ready`), but a future spec
  // addition shouldn't leak into the inner view.
  if (typeof data.method === 'string' && data.method.startsWith('ui/notifications/sandbox-')) {
    if (data.method === 'ui/notifications/sandbox-resource-ready') {
      const params = (data.params as SandboxResourceReadyParams | undefined) ?? { html: '' };
      createInnerIframe(params);
    }
    // All other sandbox-* methods are dropped silently.
    return;
  }
  // Everything else: host → inner iframe pass-through.
  if (innerIframe?.contentWindow) {
    innerIframe.contentWindow.postMessage(data, '*');
  }
  // If a host message arrives before the inner iframe exists (shouldn't
  // happen if the host follows the spec — it MUST wait for
  // `initialized`), we drop it. Surfacing this as an error would risk
  // breaking misbehaving but otherwise-functional hosts.
}

function handleFromInner(data: JsonRpcMessage): void {
  // Reserved sandbox messages: inner iframe MUST NOT use these. Block
  // forwarding so a misbehaving app can't impersonate the proxy.
  if (typeof data.method === 'string' && data.method.startsWith('ui/notifications/sandbox-')) {
    return;
  }
  // Everything else: inner iframe → host pass-through.
  window.parent.postMessage(data, '*');
}

// ─── Inner iframe construction ───────────────────────────────────────

function createInnerIframe(params: SandboxResourceReadyParams): void {
  // Hot-replace: if the host sends a new resource (rare but not
  // explicitly forbidden by spec), tear down the old iframe first so we
  // never have two live apps in one proxy. Each `<AppRenderer>`
  // instance gets its own proxy iframe on the host side, so in practice
  // this only fires on dev-time reloads.
  if (innerIframe) {
    innerIframe.remove();
    innerIframe = null;
  }

  const iframe = document.createElement('iframe');

  // Sandbox tokens are FIXED — we ignore `params.sandbox`. SEP-1865
  // rule 2 requires `allow-scripts allow-same-origin` and lets the host
  // grant additional capabilities only via the iframe `allow` attribute
  // below. A malicious server must NOT be able to widen the sandbox by
  // requesting e.g. `allow-top-navigation` or `allow-popups-to-escape-sandbox`.
  iframe.setAttribute('sandbox', INNER_SANDBOX);

  const allowAttr = buildAllowAttribute(params.permissions);
  if (allowAttr) iframe.setAttribute('allow', allowAttr);

  // Wrap, never inject. Synthesising a fresh outer document with our
  // <meta CSP> in the head means hostile parser tricks in the served
  // HTML (comments hiding a fake <head>, CDATA, attribute-embedded
  // tags) can't smuggle a more-permissive CSP earlier than ours. The
  // browser's HTML parser collapses any duplicate <html>/<head>/<body>
  // the server may include.
  iframe.srcdoc = wrapWithCspDocument(params.html, buildCsp(params.csp));

  document.body.appendChild(iframe);
  innerIframe = iframe;
}

/**
 * Construct a CSP from the resource's declared domains.
 *
 * Matches the spec's recommended default (section "Content Security
 * Policy Enforcement"): start from `default-src 'none'` and explicitly
 * open the directives the app declared a need for.
 *
 * Notable choices:
 *   - `'unsafe-inline'` for `script-src` / `style-src`: most MCP App
 *     bundles inline JS/CSS (draw.io's ~350 KB single-file output does).
 *     Without this, nothing renders. The sandboxed origin contains the
 *     damage — inline scripts in an opaque-origin iframe can't reach the
 *     extension.
 *   - `connect-src 'self'`: deliberately permissive vs the spec's
 *     `connect-src 'none'` default. Apps frequently fetch back into
 *     themselves via blob: / data: URIs for late-loaded chunks; without
 *     `'self'` those fail.
 *   - `data:` / `blob:` on img/font/media: real-world apps use these
 *     for icon fonts and `URL.createObjectURL` media. Spec example omits
 *     them; defensible loosening since these schemes can't exfiltrate.
 *
 * Every server-supplied domain is filtered through `DOMAIN_RE`. Anything
 * containing CSP-meaningful characters (semicolons, quotes, whitespace)
 * is silently dropped — a hostile server can't append extra directives.
 */
function buildCsp(csp: CspMeta | undefined): string {
  const resource = sanitiseDomains(csp?.resourceDomains);
  const connect = sanitiseDomains(csp?.connectDomains);
  const frame = sanitiseDomains(csp?.frameDomains);
  const baseUri = sanitiseDomains(csp?.baseUriDomains);

  const join = (...parts: string[]): string => parts.filter(Boolean).join(' ');

  return [
    "default-src 'none'",
    `script-src ${join("'self'", "'unsafe-inline'", resource)}`,
    `style-src ${join("'self'", "'unsafe-inline'", resource)}`,
    `connect-src ${join("'self'", connect)}`,
    `img-src ${join("'self'", 'data:', 'blob:', resource)}`,
    `font-src ${join("'self'", 'data:', resource)}`,
    `media-src ${join("'self'", 'data:', 'blob:', resource)}`,
    `frame-src ${frame || "'none'"}`,
    "object-src 'none'",
    `base-uri ${baseUri || "'self'"}`,
  ].join('; ');
}

/** Filter a server-supplied domain list down to entries matching `DOMAIN_RE`. */
function sanitiseDomains(domains: string[] | undefined): string {
  if (!domains?.length) return '';
  return domains.filter((d) => typeof d === 'string' && DOMAIN_RE.test(d)).join(' ');
}

/** Map declared permissions to the iframe `allow` attribute. */
function buildAllowAttribute(perms: PermissionsMeta | undefined): string {
  if (!perms) return '';
  const features: string[] = [];
  if (perms.camera) features.push('camera');
  if (perms.microphone) features.push('microphone');
  if (perms.geolocation) features.push('geolocation');
  if (perms.clipboardWrite) features.push('clipboard-write');
  return features.join('; ');
}

/**
 * Wrap server-supplied HTML in a fresh outer document whose `<head>`
 * carries our CSP `<meta>`. Anything the server included at the document
 * level (its own `<html>`, `<head>`, `<body>`) is collapsed by the HTML
 * parser as duplicate tags; our CSP wins because it is parsed first.
 *
 * This deliberately replaces the older inject-via-regex approach, which
 * was defeatable by `<!-- <head> --> <head>real</head>` decoys.
 */
function wrapWithCspDocument(html: string, csp: string): string {
  // CSP value goes inside an attribute, so quote-escape. Newlines are
  // already disallowed via `DOMAIN_RE` so the only risky char is `"`.
  const cspAttr = csp.replace(/"/g, '&quot;');
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${cspAttr}"></head><body>${html}</body></html>`;
}


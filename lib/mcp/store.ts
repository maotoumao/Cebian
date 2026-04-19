import {
  mcpServers,
  type MCPServerConfig,
  type MCPTransportConfig,
  type MCPAuthConfig,
} from '@/lib/storage';

/**
 * CRUD helpers around the `mcpServers` storage item.
 *
 * All mutations go through here so we can centralise validation, timestamp
 * bookkeeping, and (later) emit change events for the manager to react to.
 *
 * UI components should prefer `useStorageItem(mcpServers)` for reactive reads
 * and call these helpers for writes.
 */

export interface MCPServerInput {
  name: string;
  enabled?: boolean;
  transport: MCPTransportConfig;
  auth?: MCPAuthConfig;
}

/**
 * Validates and returns a normalized copy of `input` (trimmed name/url/token).
 * Throws on invalid input.
 */
function validateAndNormalize(input: MCPServerInput): MCPServerInput {
  const name = input.name?.trim();
  if (!name) throw new Error('MCP server name is required');

  const url = input.transport?.url?.trim();
  if (!url) throw new Error('MCP server URL is required');

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid MCP server URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported MCP server URL scheme: ${parsed.protocol}`);
  }

  if (input.transport.type !== 'http' && input.transport.type !== 'sse') {
    throw new Error(`Unsupported MCP transport: ${String(input.transport.type)}`);
  }

  let auth: MCPAuthConfig = input.auth ?? { type: 'none' };
  if (auth.type === 'bearer') {
    const token = auth.token?.trim();
    if (!token) throw new Error('Bearer token is required when auth.type is "bearer"');
    auth = { type: 'bearer', token };
  }

  // Reject Authorization in transport.headers when bearer auth is set —
  // the client wrapper would silently overwrite it, which is confusing.
  if (auth.type === 'bearer' && input.transport.headers) {
    for (const key of Object.keys(input.transport.headers)) {
      if (key.toLowerCase() === 'authorization') {
        throw new Error('Do not set the Authorization header manually when using bearer auth — set the token in the auth field instead.');
      }
    }
  }

  return {
    name,
    enabled: input.enabled,
    transport: { ...input.transport, url },
    auth,
  };
}

export async function listMCPServers(): Promise<MCPServerConfig[]> {
  return mcpServers.getValue();
}

export async function getMCPServer(id: string): Promise<MCPServerConfig | undefined> {
  const all = await mcpServers.getValue();
  return all.find((s) => s.id === id);
}

export async function addMCPServer(input: MCPServerInput): Promise<MCPServerConfig> {
  const norm = validateAndNormalize(input);
  const now = Date.now();
  const config: MCPServerConfig = {
    id: crypto.randomUUID(),
    name: norm.name,
    enabled: norm.enabled ?? true,
    transport: norm.transport,
    auth: norm.auth!,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  const all = await mcpServers.getValue();
  await mcpServers.setValue([...all, config]);
  return config;
}

/**
 * Patch an MCP server. `transport` and `auth` are SHALLOW-MERGED with the
 * existing record so callers may pass `{ transport: { url: 'new' } }` without
 * clobbering `headers`. To fully replace either object, spread it explicitly.
 */
export async function updateMCPServer(
  id: string,
  patch: {
    name?: string;
    enabled?: boolean;
    transport?: Partial<MCPTransportConfig>;
    auth?: MCPAuthConfig;
  },
): Promise<MCPServerConfig> {
  const all = await mcpServers.getValue();
  const idx = all.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error(`MCP server not found: ${id}`);
  const current = all[idx];
  const mergedTransport: MCPTransportConfig = patch.transport
    ? { ...current.transport, ...patch.transport }
    : current.transport;
  const mergedAuth: MCPAuthConfig = patch.auth ?? current.auth;
  const norm = validateAndNormalize({
    name: patch.name ?? current.name,
    enabled: patch.enabled ?? current.enabled,
    transport: mergedTransport,
    auth: mergedAuth,
  });
  const next: MCPServerConfig = {
    ...current,
    name: norm.name,
    enabled: norm.enabled ?? current.enabled,
    transport: norm.transport,
    auth: norm.auth!,
    updatedAt: Date.now(),
  };
  const copy = [...all];
  copy[idx] = next;
  await mcpServers.setValue(copy);
  return next;
}

export async function removeMCPServer(id: string): Promise<void> {
  const all = await mcpServers.getValue();
  await mcpServers.setValue(all.filter((s) => s.id !== id));
}

/**
 * Toggle the `enabled` flag without re-validating transport/auth, so users can
 * disable a record that has become invalid (e.g. expired token, stricter
 * validator shipped in a later version).
 */
export async function setMCPServerEnabled(id: string, enabled: boolean): Promise<MCPServerConfig> {
  const all = await mcpServers.getValue();
  const idx = all.findIndex((s) => s.id === id);
  if (idx === -1) throw new Error(`MCP server not found: ${id}`);
  const next: MCPServerConfig = { ...all[idx], enabled, updatedAt: Date.now() };
  const copy = [...all];
  copy[idx] = next;
  await mcpServers.setValue(copy);
  return next;
}

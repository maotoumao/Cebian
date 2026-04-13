/**
 * Interactive tool registry (background-side).
 *
 * Manages bridge instances for interactive tools that pause the agent
 * and wait for user input. UI rendering is handled by ui-registry.ts.
 */

import type { InteractiveBridge, PendingRequest } from './interactive-bridge';

/**
 * Registration input for a bridge-backed interactive tool.
 */
export interface InteractiveToolRegistration<TRequest = any, TResponse = any> {
  name: string;
  bridge: InteractiveBridge<TRequest, TResponse>;
}

/**
 * Public info about a registered tool (bridge not exposed).
 */
export interface InteractiveToolInfo {
  name: string;
}

type Listener = () => void;

class InteractiveToolRegistry {
  private tools = new Map<string, InteractiveToolRegistration>();
  private listeners = new Set<Listener>();
  private bridgeUnsubs = new Map<Listener, (() => void)[]>();
  private infoCache = new Map<string, InteractiveToolInfo>();

  /** Register an interactive tool. Call at module load time. */
  register<TReq, TRes>(meta: InteractiveToolRegistration<TReq, TRes>): void {
    if (this.tools.has(meta.name)) {
      console.warn(`InteractiveToolRegistry: tool "${meta.name}" already registered, overwriting`);
    }
    this.tools.set(meta.name, meta as InteractiveToolRegistration);
    this.infoCache.set(meta.name, { name: meta.name });
    // Subscribe existing listeners to the new tool's bridge
    for (const [cb, unsubs] of [...this.bridgeUnsubs]) {
      unsubs.push(meta.bridge.subscribe(() => cb()));
    }
    this.notify();
  }

  /** Look up a tool's public info by name (bridge not exposed). Returns stable reference. */
  get(name: string): InteractiveToolInfo | undefined {
    return this.infoCache.get(name);
  }

  /** Get all registered tools' public info. */
  getAll(): InteractiveToolInfo[] {
    return Array.from(this.infoCache.values());
  }

  /** Get the pending request for a specific tool, if any. */
  getPendingFor(toolName: string): PendingRequest<any> | null {
    return this.tools.get(toolName)?.bridge.getPending() ?? null;
  }

  /** Resolve a pending interactive tool's request. */
  resolve(toolName: string, response: any): void {
    this.tools.get(toolName)?.bridge.resolve(response);
  }

  /** Check if any registered tool currently has a pending request. */
  hasPending(): boolean {
    for (const tool of this.tools.values()) {
      if (tool.bridge.getPending()) return true;
    }
    return false;
  }

  /** Cancel all pending interactive tools. */
  cancelAll(): void {
    for (const tool of this.tools.values()) {
      tool.bridge.cancel();
    }
  }

  /** Cancel a specific pending interactive tool. */
  cancelOne(toolName: string): void {
    this.tools.get(toolName)?.bridge.cancel();
  }

  /** Subscribe to registry changes. Returns unsubscribe fn. */
  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    // Subscribe to all current bridge pending state changes
    const unsubs: (() => void)[] = [];
    for (const tool of this.tools.values()) {
      unsubs.push(tool.bridge.subscribe(() => cb()));
    }
    this.bridgeUnsubs.set(cb, unsubs);
    return () => {
      this.listeners.delete(cb);
      const subs = this.bridgeUnsubs.get(cb);
      if (subs) {
        subs.forEach(u => u());
        this.bridgeUnsubs.delete(cb);
      }
    };
  }

  private notify(): void {
    for (const cb of [...this.listeners]) cb();
  }
}

/** Singleton registry for all interactive tools. */
export const interactiveToolRegistry = new InteractiveToolRegistry();

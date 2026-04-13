// SessionToolContext: unified manager for all per-session interactive tool bridges.
// Agent-manager interacts with this single interface, regardless of how many
// interactive tools exist. Adding a new interactive tool requires zero changes
// to agent-manager — only register it here via ctx.register().

import type { InteractiveBridge, PendingRequest } from './interactive-bridge';

export type ToolStateCallback = (
  toolName: string,
  pending: PendingRequest<any> | null,
) => void;

export class SessionToolContext {
  private bridges = new Map<string, InteractiveBridge<any, any>>();
  private bridgeUnsubs: (() => void)[] = [];
  private pendingState = new Map<string, boolean>();
  private listeners = new Set<ToolStateCallback>();

  /** Register a bridge for an interactive tool. Call during session setup. */
  register(toolName: string, bridge: InteractiveBridge<any, any>): void {
    this.bridges.set(toolName, bridge);
    this.pendingState.set(toolName, false);

    // Subscribe to this bridge's state and detect transitions
    const unsub = bridge.subscribe((pending) => {
      const wasPending = this.pendingState.get(toolName) ?? false;
      const isPending = !!pending;

      if (isPending && !wasPending) {
        this.pendingState.set(toolName, true);
        for (const cb of this.listeners) cb(toolName, pending);
      } else if (!isPending && wasPending) {
        this.pendingState.set(toolName, false);
        for (const cb of this.listeners) cb(toolName, null);
      }
    });
    this.bridgeUnsubs.push(unsub);
  }

  /** Get the pending request for a specific tool. */
  getPending(toolName: string): PendingRequest<any> | null {
    return this.bridges.get(toolName)?.getPending() ?? null;
  }

  /** Check if any registered tool has a pending request. */
  hasPending(): boolean {
    for (const bridge of this.bridges.values()) {
      if (bridge.getPending()) return true;
    }
    return false;
  }

  /** Resolve a specific tool's pending request with the user's response. */
  resolve(toolName: string, response: any): void {
    this.bridges.get(toolName)?.resolve(response);
  }

  /** Cancel a specific tool's pending request. */
  cancel(toolName: string): void {
    this.bridges.get(toolName)?.cancel();
  }

  /** Cancel all pending interactive tools. */
  cancelAll(): void {
    for (const bridge of this.bridges.values()) {
      bridge.cancel();
    }
  }

  /**
   * Subscribe to tool state changes across all registered bridges.
   * Callback fires only on actual transitions (null→pending or pending→null).
   */
  subscribe(cb: ToolStateCallback): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Clean up all bridge subscriptions. */
  dispose(): void {
    for (const unsub of this.bridgeUnsubs) unsub();
    this.bridgeUnsubs = [];
    this.listeners.clear();
    this.bridges.clear();
    this.pendingState.clear();
  }
}

/**
 * Interactive tool registry.
 *
 * Only interactive tools (those that pause the agent and display UI for user input)
 * need to register here. Non-interactive tools (e.g. executeScript) don't need this.
 *
 * Purpose: lets ChatPage render any interactive tool's UI generically,
 * without hardcoding tool names or components.
 */

import type { ComponentType } from 'react';
import type { InteractiveBridge, PendingRequest } from './interactive-bridge';
import type { ToolResultMessage } from '@mariozechner/pi-ai';

/**
 * Props that every interactive tool UI component receives.
 * The registry renders these generically — each tool only provides the Component.
 */
export interface InteractiveToolComponentProps<TRequest = any> {
  toolCallId: string;
  args: TRequest;
  isPending: boolean;
  toolResult?: ToolResultMessage;
  onResolve?: (response: any) => void;
}

/**
 * Public view of a registered tool — bridge is NOT exposed.
 * This is what consumers (ChatPage, hooks) receive from the registry.
 */
export interface InteractiveToolInfo<TRquest = any> {
  name: string;
  Component: ComponentType<InteractiveToolComponentProps<TRquest>>;
  renderResultAsUserBubble?: boolean;
}

/**
 * Registration input — extends InteractiveToolInfo with the bridge.
 * Only used as the argument to `registry.register()`. Not exported.
 */
interface InteractiveToolWithBridge<TRequest = any, TResponse = any> extends InteractiveToolInfo {
  /** The bridge instance connecting tool.execute() ↔ React UI */
  bridge: InteractiveBridge<TRequest, TResponse>;
}


type Listener = () => void;

class InteractiveToolRegistry {
  private tools = new Map<string, InteractiveToolWithBridge>();
  private listeners = new Set<Listener>();
  /** Per-listener unsubscribe fns for bridge subscriptions, so late-registered tools can be added. */
  private bridgeUnsubs = new Map<Listener, (() => void)[]>();
  /** Cached public info objects — stable references for React consumers. */
  private infoCache = new Map<string, InteractiveToolInfo>();

  /** Register an interactive tool. Call at module load time. */
  register<TReq, TRes>(meta: InteractiveToolWithBridge<TReq, TRes>): void {
    if (this.tools.has(meta.name)) {
      console.warn(`InteractiveToolRegistry: tool "${meta.name}" already registered, overwriting`);
    }
    this.tools.set(meta.name, meta as InteractiveToolWithBridge);
    // Update info cache
    this.infoCache.set(meta.name, {
      name: meta.name, Component: meta.Component, renderResultAsUserBubble: meta.renderResultAsUserBubble,
    });
    // Subscribe existing listeners to the new tool's bridge (snapshot to avoid mutation during iteration)
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

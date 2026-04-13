// UI-side interactive tool registry.
// Maps tool names → React components for rendering in sidepanel.
// Bridge logic stays in background; this is purely for UI rendering.

import type { ComponentType } from 'react';
import type { ToolResultMessage } from '@mariozechner/pi-ai';

/** Props that every interactive tool UI component receives. */
export interface InteractiveToolComponentProps<TRequest = any> {
  toolCallId: string;
  args: TRequest;
  isPending: boolean;
  toolResult?: ToolResultMessage;
  onResolve?: (response: any) => void;
}

export interface UIToolRegistration<TRequest = any> {
  name: string;
  Component: ComponentType<InteractiveToolComponentProps<TRequest>>;
  renderResultAsUserBubble?: boolean;
}

class UIToolRegistry {
  private tools = new Map<string, UIToolRegistration>();

  register<TReq>(meta: UIToolRegistration<TReq>): void {
    this.tools.set(meta.name, meta as UIToolRegistration);
  }

  get(name: string): UIToolRegistration | undefined {
    return this.tools.get(name);
  }

  getAll(): UIToolRegistration[] {
    return Array.from(this.tools.values());
  }
}

/** Singleton UI tool registry for the sidepanel. */
export const uiToolRegistry = new UIToolRegistry();

/**
 * Generic interactive tool bridge.
 *
 * Connects a tool's `execute()` (which runs outside React) to a React UI component
 * that collects user input. Each interactive tool creates its own bridge instance
 * via `createInteractiveBridge<TRequest, TResponse>()`.
 *
 * Lifecycle: tool.execute() → bridge.request() → pending state → UI renders →
 *            user interacts → bridge.resolve()/cancel() → execute() returns
 */

/** Sentinel value returned when the user cancels an interactive tool request. */
export const INTERACTIVE_CANCELLED = Symbol.for('interactive-cancelled');
export type InteractiveCancelled = typeof INTERACTIVE_CANCELLED;

export interface PendingRequest<TRequest> {
  toolCallId: string;
  request: TRequest;
}

export type PendingChangeCallback<TRequest> = (
  pending: PendingRequest<TRequest> | null,
) => void;

export interface InteractiveBridge<TRequest, TResponse> {
  /**
   * Called by tool.execute(). Creates a pending Promise that blocks until
   * the user responds or the request is cancelled/aborted.
   */
  request(
    toolCallId: string,
    req: TRequest,
    signal?: AbortSignal,
  ): Promise<TResponse | InteractiveCancelled>;

  /** Called by React UI when the user provides a response. */
  resolve(response: TResponse): void;

  /** Called when the user bypasses the tool (e.g. sends a message via ChatInput). */
  cancel(): void;

  /** Subscribe to pending state changes. Returns an unsubscribe function. */
  subscribe(cb: PendingChangeCallback<TRequest>): () => void;

  /** Get the current pending request, if any. */
  getPending(): PendingRequest<TRequest> | null;
}

/**
 * Factory: creates a typed interactive bridge instance.
 *
 * Usage:
 * ```ts
 * const bridge = createInteractiveBridge<AskUserRequest, string>();
 * // In tool.execute():  const result = await bridge.request(id, params, signal);
 * // In React:           bridge.resolve(userText);
 * ```
 */
export function createInteractiveBridge<
  TRequest,
  TResponse,
>(): InteractiveBridge<TRequest, TResponse> {
  let pending: PendingRequest<TRequest> | null = null;
  let pendingResolve: ((value: TResponse | InteractiveCancelled) => void) | null = null;
  const listeners = new Set<PendingChangeCallback<TRequest>>();

  function notify() {
    for (const cb of listeners) cb(pending);
  }

  function cleanup() {
    pending = null;
    pendingResolve = null;
    notify();
  }

  return {
    request(toolCallId, req, signal) {
      // If there's already a pending request, cancel it before starting a new one
      if (pendingResolve) {
        pendingResolve(INTERACTIVE_CANCELLED);
        cleanup();
      }

      return new Promise<TResponse | InteractiveCancelled>((resolve) => {
        pending = { toolCallId, request: req };
        pendingResolve = resolve;
        notify();

        // Honor abort signal
        if (signal) {
          const onAbort = () => {
            if (pendingResolve === resolve) {
              resolve(INTERACTIVE_CANCELLED);
              cleanup();
            }
          };
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }
      });
    },

    resolve(response) {
      if (pendingResolve) {
        pendingResolve(response);
        cleanup();
      }
    },

    cancel() {
      if (pendingResolve) {
        pendingResolve(INTERACTIVE_CANCELLED);
        cleanup();
      }
    },

    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    getPending() {
      return pending;
    },
  };
}

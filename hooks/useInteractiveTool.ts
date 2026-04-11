import { useSyncExternalStore } from 'react';
import type {
  InteractiveBridge,
  PendingRequest,
} from '@/lib/tools/interactive-bridge';

/**
 * React hook that subscribes to an InteractiveBridge's pending state.
 *
 * Returns the current pending request (if any) plus resolve/cancel helpers.
 * Works with any interactive tool bridge — fully typed via generics.
 */
export function useInteractiveTool<TRequest, TResponse>(
  bridge: InteractiveBridge<TRequest, TResponse>,
) {
  const pending = useSyncExternalStore<PendingRequest<TRequest> | null>(
    (cb) => bridge.subscribe(cb),
    () => bridge.getPending(),
  );

  return {
    pending,
    resolve: bridge.resolve.bind(bridge),
    cancel: bridge.cancel.bind(bridge),
  };
}

import { useSyncExternalStore, useCallback } from 'react';
import { interactiveToolRegistry, type InteractiveToolInfo } from '@/lib/tools/registry';
import type { PendingRequest } from '@/lib/tools/interactive-bridge';

/**
 * Hook that subscribes to ALL registered interactive tools' pending states.
 * Returns helpers to check pending, resolve, cancel — all tool-agnostic.
 * Bridge is never exposed; all operations go through the registry.
 */
export function useInteractiveTools() {
  const hasPending = useSyncExternalStore(
    (cb) => interactiveToolRegistry.subscribe(cb),
    () => interactiveToolRegistry.hasPending(),
  );

  const cancelAll = useCallback(() => {
    interactiveToolRegistry.cancelAll();
  }, []);

  const getInteractiveToolInfo = useCallback((toolName: string): InteractiveToolInfo | undefined => {
    return interactiveToolRegistry.get(toolName);
  }, []);

  const getPendingFor = useCallback((toolName: string): PendingRequest<any> | null => {
    return interactiveToolRegistry.getPendingFor(toolName);
  }, []);

  const resolve = useCallback((toolName: string, response: any): void => {
    interactiveToolRegistry.resolve(toolName, response);
  }, []);

  return { hasPending, cancelAll, getInteractiveToolInfo, getPendingFor, resolve };
}

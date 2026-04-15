import type { DialogName, DialogRegistry } from '@/components/dialogs';

// Discriminated union of all possible dialog states
export type DialogState = {
  [K in DialogName]: { name: K; options: DialogRegistry[K] };
}[DialogName];

type Listener = (state: DialogState | null) => void;
let _listener: Listener | null = null;

export function showDialog<T extends DialogName>(name: T, options: DialogRegistry[T]): void {
  _listener?.({ name, options } as DialogState);
}

export function closeDialog(): void {
  _listener?.(null);
}

export function onDialogChange(fn: Listener): () => void {
  _listener = fn;
  return () => { if (_listener === fn) _listener = null; };
}

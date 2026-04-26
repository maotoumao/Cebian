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

// ─── Confirm dialog (independent from showDialog — different UX semantics) ───

export interface ConfirmOptions {
  title: string;
  description?: string;
  /** Defaults to t('common.confirm'). */
  confirmText?: string;
  /** Defaults to t('common.cancel'). */
  cancelText?: string;
  /** When true, the confirm button uses the destructive (red) variant. */
  destructive?: boolean;
}

export interface ConfirmState {
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

type ConfirmListener = (state: ConfirmState | null) => void;
let _confirmListener: ConfirmListener | null = null;
/** In-flight confirm resolve, settled to `false` when superseded or dismissed. */
let _pendingConfirmResolve: ((ok: boolean) => void) | null = null;

/**
 * Show a confirmation dialog. Resolves to `true` if the user confirms,
 * `false` if cancelled (Cancel button or ESC key). Radix AlertDialog
 * intentionally does not dismiss on overlay click — that is the UX contract
 * for destructive prompts and we honour it.
 *
 * If no `ConfirmOutlet` is mounted, resolves to `false` immediately
 * (fail-closed: a destructive action must never proceed without explicit
 * confirmation).
 *
 * Single-flight: invoking again while a confirm is open settles the previous
 * promise to `false` before publishing the new state.
 */
export function showConfirm(options: ConfirmOptions): Promise<boolean> {
  if (!_confirmListener) return Promise.resolve(false);

  // Cancel any previous in-flight confirm so its awaiter doesn't hang.
  _pendingConfirmResolve?.(false);
  _pendingConfirmResolve = null;

  return new Promise<boolean>((resolve) => {
    const settle = (ok: boolean) => {
      if (_pendingConfirmResolve === settle) _pendingConfirmResolve = null;
      resolve(ok);
    };
    _pendingConfirmResolve = settle;
    _confirmListener?.({ options, resolve: settle });
  });
}

export function onConfirmChange(fn: ConfirmListener): () => void {
  _confirmListener = fn;
  return () => { if (_confirmListener === fn) _confirmListener = null; };
}

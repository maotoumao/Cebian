import { useState, useEffect, useRef } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { onConfirmChange, type ConfirmState } from '@/lib/dialog';
import { t } from '@/lib/i18n';

/**
 * Render slot for `showConfirm()`. Mount exactly one per JS context.
 * Currently mounted in `entrypoints/sidepanel/App.tsx` and
 * `entrypoints/settings/App.tsx`; those are separate HTML documents so each
 * gets its own `_confirmListener` instance and they cannot collide.
 *
 * Do NOT mount an additional ConfirmOutlet inside `SettingsRoutes` — it is
 * embedded in the sidepanel and would compete with the sidepanel's outlet for
 * the single module-level listener slot.
 */
export function ConfirmOutlet() {
  const [state, setState] = useState<ConfirmState | null>(null);
  // Tracks the latest state so the unmount cleanup can resolve a pending
  // promise without depending on stale closure values.
  const stateRef = useRef<ConfirmState | null>(null);
  stateRef.current = state;

  useEffect(() => {
    const off = onConfirmChange(setState);
    return () => {
      // Settle any in-flight confirm so awaiters don't hang on HMR / unmount.
      stateRef.current?.resolve(false);
      off();
    };
  }, []);

  if (!state) return null;
  const { options } = state;

  // Radix's onOpenChange is the single source of dismissal. The Cancel button
  // closes the dialog through it (no explicit onClick needed); the Action
  // button uses an explicit handler so the resolved value is `true`.
  function handleClose() {
    state?.resolve(false);
    setState(null);
  }

  function handleConfirm() {
    state?.resolve(true);
    setState(null);
  }

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) handleClose(); }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{options.title}</AlertDialogTitle>
          {options.description && (
            <AlertDialogDescription>{options.description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            {options.cancelText ?? t('common.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            variant={options.destructive ? 'destructive' : 'default'}
          >
            {options.confirmText ?? t('common.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

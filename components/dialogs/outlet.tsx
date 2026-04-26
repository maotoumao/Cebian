import { useState, useEffect } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { onDialogChange, type DialogState } from '@/lib/dialog';
import { dialogRenderers } from '.';

export function DialogOutlet() {
  const [state, setState] = useState<DialogState | null>(null);

  useEffect(() => onDialogChange(setState), []);

  if (!state) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Component = dialogRenderers[state.name] as React.ComponentType<any>;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) setState(null); }}>
      <DialogContent className="max-w-[calc(100%-2rem)] max-h-[90vh] flex flex-col gap-0 p-0" autoFocus={false}>
        <Component {...state.options} />
      </DialogContent>
    </Dialog>
  );
}

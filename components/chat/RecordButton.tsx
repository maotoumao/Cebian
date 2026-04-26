// Toolbar button that toggles the user-action recorder.
//
// Icon-only. The state difference is expressed purely through icon
// color + a subtle pulse when actively recording — no inline counters
// or elapsed time (the attachment chip carries that info once the
// session finalizes).
//
// Idle (and "foreign" — another instance is recording, but from this
//   sidepanel's POV the button is just inert/idle): neutral `CircleDot`
//   icon, tooltip "Start recording". Clicking while another instance
//   owns the recording posts a `recorder_start` that the BG rejects;
//   the rejection toast lives in `useRecorder`, not here.
// Owned-recording: same `CircleDot` icon in rose with a gentle pulse,
//   tooltip "Stop recording". Auto-stops (`truncated` set in status)
//   emit a one-shot toast so the user knows why recording ended.

import { useEffect, useRef } from 'react';
import { CircleDot } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useRecorder } from '@/hooks/useRecorder';
import { t } from '@/lib/i18n';

export interface RecordButtonProps {
  /** Disable the start button (e.g. while the agent is running). Has no
   *  effect on the stop affordance — losing the recording because of an
   *  unrelated agent run would be worse than letting the user free up the
   *  tab observer. */
  disabled?: boolean;
}

export function RecordButton({ disabled }: RecordButtonProps) {
  const { isOwner, truncated, startedAt, start, stop } = useRecorder();

  // Toast on auto-stop. Latch on (startedAt, truncated) tuple so each
  // recording session that ends with a truncation reason fires exactly
  // once, regardless of broadcast ordering or whether the BG sends a
  // clean intermediate status.
  const lastToastedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!truncated || startedAt == null) return;
    // Only the owning instance's sidepanel toasts auto-stop.
    if (!isOwner) return;
    const key = `${startedAt}:${truncated}`;
    if (lastToastedRef.current === key) return;
    lastToastedRef.current = key;
    const i18nKey = truncated === 'event_limit'
      ? 'chat.recorder.autoStoppedEvents'
      : 'chat.recorder.autoStoppedTime';
    toast.info(t(i18nKey));
  }, [truncated, startedAt, isOwner]);

  if (isOwner) {
    return (
      <Button
        variant="ghost"
        size="icon-xs"
        title={t('chat.recorder.stop')}
        onClick={() => { void stop(); }}
        // Always allow stopping, even while the agent is running — losing
        // the recording because of an unrelated agent run is worse than
        // letting the user free up the tab observer.
        className="text-rose-500 hover:text-rose-400 hover:bg-rose-500/10"
      >
        <CircleDot className="size-3.5 animate-pulse" />
      </Button>
    );
  }

  // Idle from this instance's perspective. If another instance is recording,
  // clicking still posts `recorder_start` — the BG replies with
  // `recorder_start_rejected: { reason: 'busy' }` and useRecorder toasts.
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      title={t('chat.recorder.start')}
      onClick={start}
      disabled={disabled}
    >
      <CircleDot className="size-3.5" />
    </Button>
  );
}

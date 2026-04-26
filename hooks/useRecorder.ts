// useRecorder — sidepanel hook for the user-action recorder.
//
// Subscribes to status broadcasts via the `recorderChannel` singleton (the
// underlying port is owned by `useBackgroundAgent`). Exposes start/stop
// and status flags the toolbar button needs.
//
// `stop()` returns a `Promise<void>` that resolves once the background has
// finalized the recording. The captured session itself is NOT returned
// from this hook — it flows through `recorderChannel.subscribeSession`
// (see ChatInput) so that every consumer (manual stop button, send-time
// auto-stop, cap-trigger) lands the session in attachments via the same
// path. We arm a one-shot session listener internally only as the resolve
// trigger; the BG fires it synchronously inside `recorder.stop()` so the
// promise effectively resolves as fast as the port round-trip allows.

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { recorderChannel, type RecorderStatus } from '@/lib/recorder/sidepanel-channel';
import { myInstanceId } from '@/lib/instance-id';
import { t } from '@/lib/i18n';

export interface UseRecorderResult {
  /** True if *this* sidepanel/tab instance started the active recording.
   *  False when idle, OR when another instance owns the recording — in
   *  the latter case the button still renders as idle (clicking it just
   *  triggers a `recorder_start_rejected` toast). */
  isOwner: boolean;
  /** Auto-stop reason from the background, if the recording was truncated. */
  truncated: 'event_limit' | 'time_limit' | undefined;
  /** Absolute timestamp the current/last recording started. Used for latching
   *  one-shot effects to a specific recording. */
  startedAt: number | null;
  /** Start a new recording on the focused window. No-op if another
   *  instance already owns the recording — the BG rejects and a toast
   *  surfaces the reason. */
  start: () => void;
  /** Stop the active recording. Resolves once the background has finalized.
   *  The captured session is delivered via `recorderChannel.subscribeSession`
   *  (consumed by ChatInput which appends it as a `RecordingAttachment`),
   *  not as the return value here. Resolves immediately when not recording
   *  or when the channel is disconnected. */
  stop: () => Promise<void>;
}

// Module-level singleton: install the rejection toast subscription once,
// regardless of how many components call `useRecorder()`. Without this,
// every consumer (ChatInput + RecordButton + …) would register its own
// subscriber and a single 'busy' rejection would fire N toasts. The
// channel lives for the sidepanel's lifetime so we never need to tear
// this down.
let rejectionToastInstalled = false;
function installRejectionToastsOnce(): void {
  if (rejectionToastInstalled) return;
  rejectionToastInstalled = true;
  recorderChannel.subscribeRejection(({ reason }) => {
    if (reason === 'busy') {
      toast.warning(t('chat.recorder.startRejectedBusy'));
    }
    // 'before_hello' is a programming error (we send hello synchronously
    // on connect, so this should never happen in practice). Don't toast
    // — just let it land in the console for debugging.
  });
}

export function useRecorder(): UseRecorderResult {
  const [status, setStatus] = useState<RecorderStatus>(() => recorderChannel.getStatus());

  // Subscribe to status broadcasts. The channel replays the last known
  // status synchronously on subscribe, so the first render is correct.
  useEffect(() => {
    return recorderChannel.subscribeStatus(setStatus);
  }, []);

  // Install the global rejection toast (no-op after first call). The button
  // click is intentionally not pre-disabled when another instance is
  // recording — we let the click through and surface the reason here so
  // the user gets clear feedback rather than a silent no-op.
  useEffect(() => {
    installRejectionToastsOnce();
  }, []);

  const start = useCallback(() => {
    recorderChannel.start();
  }, []);

  // Track an in-flight stop so concurrent clicks share the same promise.
  // The early-return checks below also prevent posting a stop when no
  // recording is active.
  const pendingStopRef = useRef<Promise<void> | null>(null);

  const stop = useCallback((): Promise<void> => {
    if (pendingStopRef.current) return pendingStopRef.current;

    // If the channel is disconnected or already idle, don't post a stop
    // and don't make the caller wait.
    if (!recorderChannel.isConnected()) return Promise.resolve();
    if (!recorderChannel.getStatus().isRecording) return Promise.resolve();

    const p = new Promise<void>((resolve) => {
      let done = false;

      // We use the session listener purely as a 'BG finished and delivered'
      // signal. The session itself is consumed elsewhere (ChatInput's own
      // subscribeSession effect appends it to attachments). The BG fires
      // its onRecordingFinished hook synchronously inside `recorder.stop()`,
      // and that delivery rides the same port as our stop ack, so it always
      // arrives before any subsequent message.
      const unsubscribe = recorderChannel.subscribeSession(() => {
        if (done) return;
        done = true;
        unsubscribe();
        resolve();
      });

      const posted = recorderChannel.stop();
      if (!posted) {
        // Port vanished between the isConnected check and now.
        done = true;
        unsubscribe();
        resolve();
      }
    }).finally(() => {
      // Identity check: only clear if no later stop() has overwritten us.
      if (pendingStopRef.current === p) pendingStopRef.current = null;
    });

    pendingStopRef.current = p;
    return p;
  }, []);

  // Derive ownership: a recording is 'owned' iff its initiator instance id
  // matches ours. When another instance owns it, we render as idle —
  // clicking start triggers a BG rejection that we surface via toast above.
  const isOwner =
    status.isRecording
    && status.initiatorInstanceId === myInstanceId;

  return {
    isOwner,
    truncated: status.truncated,
    startedAt: status.startedAt,
    start,
    stop,
  };
}

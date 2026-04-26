// Service Worker keep-alive with reference counting.
//
// Multiple subsystems (agent runs, active recording, ...) need to prevent
// SW termination independently. Each `acquire`s a token; the timer runs
// while at least one token is held and stops when the last is released.
//
// Mechanism: `chrome.runtime.getPlatformInfo` every 25 s resets Chrome's
// 30 s SW idle timer. Any extension API call works since Chrome 110 — we
// pick `getPlatformInfo` because it's a trivial read-only no-op.
//
// Reference: https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers#keep-sw-alive

const KEEPALIVE_INTERVAL_MS = 25_000;

let timer: number | null = null;
let refCount = 0;

/** Acquire a keep-alive token. Idempotent at the timer level — the timer
 *  starts on the 0→1 transition and stops on the 1→0. */
export function acquireKeepAlive(): void {
  refCount++;
  if (refCount === 1 && timer == null) {
    timer = setInterval(
      chrome.runtime.getPlatformInfo,
      KEEPALIVE_INTERVAL_MS,
    ) as unknown as number;
  }
}

/** Release a keep-alive token. Logs a warning on unbalanced release so
 *  bugs are visible in dev. */
export function releaseKeepAlive(): void {
  if (refCount === 0) {
    console.warn('[sw-keepalive] release without matching acquire');
    return;
  }
  refCount--;
  if (refCount === 0 && timer != null) {
    clearInterval(timer);
    timer = null;
  }
}

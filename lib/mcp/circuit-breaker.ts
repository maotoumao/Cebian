/**
 * Three-state circuit breaker (CLOSED → OPEN → HALF_OPEN → CLOSED).
 *
 * Lazy-evaluated (no timers) so it survives service-worker suspension.
 *
 * CALLER CONTRACT: Every successful `tryBegin()` MUST be paired with exactly
 * one `recordSuccess()` or `recordFailure()` call, ideally in a `finally`
 * block. Forgetting this on a HALF_OPEN probe wedges the breaker — the next
 * probe never runs until `reset()` is called.
 */
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker. */
  failureThreshold: number;
  /** How long the breaker stays OPEN before allowing a probe. */
  cooldownMs: number;
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  private state: BreakerState = 'CLOSED';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private lastError?: { message: string; at: number };

  constructor(opts: CircuitBreakerOptions) {
    if (opts.failureThreshold <= 0) throw new Error('CircuitBreaker: failureThreshold must be > 0');
    if (opts.cooldownMs <= 0) throw new Error('CircuitBreaker: cooldownMs must be > 0');
    this.failureThreshold = opts.failureThreshold;
    this.cooldownMs = opts.cooldownMs;
  }

  /**
   * Attempt to begin a request. SIDE EFFECT: in HALF_OPEN, reserves the probe
   * slot — caller MUST follow up with recordSuccess/recordFailure.
   */
  tryBegin(now: number = Date.now()): boolean {
    this.refresh(now);
    if (this.state === 'CLOSED') return true;
    if (this.state === 'HALF_OPEN') {
      if (this.probeInFlight) return false;
      this.probeInFlight = true;
      return true;
    }
    return false;
  }

  recordSuccess(now: number = Date.now()): void {
    void now;
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
    this.state = 'CLOSED';
  }

  recordFailure(error?: unknown, now: number = Date.now()): void {
    const fromHalfOpen = this.state === 'HALF_OPEN';
    this.probeInFlight = false;
    this.lastError = {
      message: error instanceof Error ? error.message : String(error ?? 'unknown'),
      at: now,
    };
    if (fromHalfOpen) {
      // Re-open immediately; reset the counter so telemetry isn't misleading.
      this.consecutiveFailures = this.failureThreshold;
      this.state = 'OPEN';
      this.openedAt = now;
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = now;
    }
  }

  getState(now: number = Date.now()): BreakerState {
    this.refresh(now);
    return this.state;
  }

  isProbeInFlight(now: number = Date.now()): boolean {
    this.refresh(now);
    return this.state === 'HALF_OPEN' && this.probeInFlight;
  }

  getLastError(): { message: string; at: number } | undefined {
    return this.lastError;
  }

  /** Milliseconds until a probe is allowed; 0 if not OPEN. */
  retryAfterMs(now: number = Date.now()): number {
    this.refresh(now);
    if (this.state !== 'OPEN') return 0;
    return Math.max(0, this.openedAt + this.cooldownMs - now);
  }

  reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
    this.lastError = undefined;
  }

  /** Promote OPEN → HALF_OPEN once cooldown has elapsed. */
  private refresh(now: number): void {
    if (this.state === 'OPEN' && now - this.openedAt >= this.cooldownMs) {
      this.state = 'HALF_OPEN';
      this.probeInFlight = false;
    }
  }
}

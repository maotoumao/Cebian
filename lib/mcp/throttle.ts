import { RateLimiter } from './rate-limiter';
import { CircuitBreaker, type BreakerState } from './circuit-breaker';

/**
 * Per-server throttle facade combining rate-limiter + circuit-breaker.
 *
 * CALLER CONTRACT: Every `acquire()` returning `{ ok: true }` MUST be paired
 * with exactly one `recordSuccess()` or `recordFailure()`, ideally in a
 * `finally` block. Forgetting this on a HALF_OPEN probe wedges the breaker.
 */
export type ThrottleRejection =
  | { ok: false; reason: 'circuit-open'; retryAfterMs: number; lastError?: string }
  | { ok: false; reason: 'probe-in-flight'; retryAfterMs: number }
  | { ok: false; reason: 'rate-limited'; retryAfterMs: number };

export type ThrottleAcquire = { ok: true } | ThrottleRejection;

export interface ThrottleOptions {
  rateLimit: number;
  rateWindowMs: number;
  failureThreshold: number;
  cooldownMs: number;
}

/** Defaults tuned to "user-driven agent on a single Chrome profile". */
export const DEFAULT_THROTTLE: ThrottleOptions = {
  rateLimit: 60,
  rateWindowMs: 60_000,
  failureThreshold: 5,
  cooldownMs: 30_000,
};

export class ServerThrottle {
  private readonly limiter: RateLimiter;
  private readonly breaker: CircuitBreaker;
  private readonly cooldownMs: number;

  constructor(opts: ThrottleOptions = DEFAULT_THROTTLE) {
    this.limiter = new RateLimiter({ limit: opts.rateLimit, windowMs: opts.rateWindowMs });
    this.breaker = new CircuitBreaker({
      failureThreshold: opts.failureThreshold,
      cooldownMs: opts.cooldownMs,
    });
    this.cooldownMs = opts.cooldownMs;
  }

  acquire(now: number = Date.now()): ThrottleAcquire {
    const limiterRetry = this.limiter.retryAfterMs(now);
    if (limiterRetry > 0) {
      return { ok: false, reason: 'rate-limited', retryAfterMs: limiterRetry };
    }
    if (this.breaker.isProbeInFlight(now)) {
      return { ok: false, reason: 'probe-in-flight', retryAfterMs: this.cooldownMs };
    }
    if (!this.breaker.tryBegin(now)) {
      return {
        ok: false,
        reason: 'circuit-open',
        retryAfterMs: this.breaker.retryAfterMs(now),
        lastError: this.breaker.getLastError()?.message,
      };
    }
    const acquired = this.limiter.tryAcquire(now);
    if (!acquired) {
      this.breaker.recordFailure(new Error('limiter race'), now);
      return { ok: false, reason: 'rate-limited', retryAfterMs: this.limiter.retryAfterMs(now) };
    }
    return { ok: true };
  }

  recordSuccess(now?: number): void {
    this.breaker.recordSuccess(now);
  }

  recordFailure(error?: unknown, now?: number): void {
    this.breaker.recordFailure(error, now);
  }

  getBreakerState(now?: number): BreakerState {
    return this.breaker.getState(now);
  }

  reset(): void {
    this.limiter.reset();
    this.breaker.reset();
  }
}
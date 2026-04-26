/**
 * Sliding-window rate limiter.
 *
 * Lazy-evaluated: no setTimeout (which would not survive service-worker
 * suspension). On each `tryAcquire`, expired timestamps are dropped.
 */
export interface RateLimiterOptions {
  /** Max calls allowed within `windowMs`. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];

  constructor(opts: RateLimiterOptions) {
    if (opts.limit <= 0) throw new Error('RateLimiter: limit must be > 0');
    if (opts.windowMs <= 0) throw new Error('RateLimiter: windowMs must be > 0');
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
  }

  /** Returns true if a call slot was acquired, false if the limit is hit. */
  tryAcquire(now: number = Date.now()): boolean {
    this.evict(now);
    if (this.timestamps.length >= this.limit) return false;
    this.timestamps.push(now);
    return true;
  }

  /** Milliseconds until the next slot frees up; 0 if a slot is available now. */
  retryAfterMs(now: number = Date.now()): number {
    this.evict(now);
    if (this.timestamps.length < this.limit) return 0;
    const oldest = this.timestamps[0];
    return Math.max(0, oldest + this.windowMs - now);
  }

  reset(): void {
    this.timestamps = [];
  }

  private evict(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i] <= cutoff) i++;
    if (i > 0) this.timestamps.splice(0, i);
  }
}

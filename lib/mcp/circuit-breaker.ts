/**
 * Three-state circuit breaker (CLOSED → OPEN → HALF_OPEN → CLOSED).
 *
 * Lazy-evaluated (no timers) so it survives service-worker suspension.
 *
 * 调用契约：每次成功的 `tryBegin()` 必须恰好配一次 `recordSuccess()`、
 * `recordFailure()`，或（仅当请求根本没发出时）`cancel()`，最好放在 `finally` 里。
 * HALF_OPEN 探测漏配会卡死熔断器——在 `reset()` 之前再也不会放行下一次探测。
 */
export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** 熔断器记下的最近一次失败；成功后清空。 */
interface BreakerError {
  message: string;
  at: number;
}

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
  private lastError?: BreakerError;

  constructor(opts: CircuitBreakerOptions) {
    if (opts.failureThreshold <= 0) throw new Error('CircuitBreaker: failureThreshold must be > 0');
    if (opts.cooldownMs <= 0) throw new Error('CircuitBreaker: cooldownMs must be > 0');
    this.failureThreshold = opts.failureThreshold;
    this.cooldownMs = opts.cooldownMs;
  }

  /**
   * 尝试开始一次请求。副作用：HALF_OPEN 时会占住探测位——调用方必须随后调用
   * recordSuccess / recordFailure / cancel 之一。
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
    // 成功后旧错误不再代表当前状态，清掉以免设置页继续显示它
    this.lastError = undefined;
  }

  /**
   * 撤回一次已 `tryBegin()` 但没有真正发出的请求：只释放 HALF_OPEN 的探测占位，
   * 不计成功也不计失败。必须紧跟在对应的 `tryBegin()` 之后同步调用，否则可能释放掉
   * 别的调用方占着的探测位。
   */
  cancel(): void {
    this.probeInFlight = false;
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

  getLastError(): BreakerError | undefined {
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

// ─── 公开 API ───

export type { BreakerError };

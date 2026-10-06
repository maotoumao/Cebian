import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit-breaker';

describe('CircuitBreaker lastError', () => {
  it('首次失败即记下错误，不必等熔断', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 1000 });
    breaker.tryBegin(0);
    breaker.recordFailure(new Error('Invalid Origin'), 10);
    expect(breaker.getState(10)).toBe('CLOSED');
    expect(breaker.getLastError()).toEqual({ message: 'Invalid Origin', at: 10 });
  });

  it('成功后清掉旧错误', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 5, cooldownMs: 1000 });
    breaker.tryBegin(0);
    breaker.recordFailure(new Error('boom'), 0);
    breaker.tryBegin(1);
    breaker.recordSuccess(1);
    expect(breaker.getLastError()).toBeUndefined();
  });

  it('cancel 只释放 HALF_OPEN 探测占位，不计失败', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    breaker.tryBegin(0);
    breaker.recordFailure(new Error('boom'), 0);
    expect(breaker.tryBegin(1000)).toBe(true);
    expect(breaker.isProbeInFlight(1000)).toBe(true);
    breaker.cancel();
    expect(breaker.getState(1000)).toBe('HALF_OPEN');
    expect(breaker.tryBegin(1000)).toBe(true);
    expect(breaker.getLastError()?.message).toBe('boom');
  });
});

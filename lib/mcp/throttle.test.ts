import { describe, expect, it } from 'vitest';
import { ServerThrottle } from './throttle';

describe('ServerThrottle lastError', () => {
  it('透传熔断器记下的错误', () => {
    const throttle = new ServerThrottle();
    expect(throttle.acquire().ok).toBe(true);
    throttle.recordFailure(new Error('403'));
    expect(throttle.getLastError()?.message).toBe('403');
  });
});

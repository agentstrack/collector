import { describe, expect, it } from 'vitest';
import { ApiError, backoffMs } from './client.js';

describe('backoffMs', () => {
  it('grows exponentially and stays within the cap', () => {
    const cap = 300_000;
    let previousMax = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      const value = backoffMs(attempt, 1000, cap);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(cap);
      previousMax = Math.max(previousMax, value);
    }
    expect(previousMax).toBeGreaterThan(1000);
  });

  it('applies jitter so a fleet does not reconnect in lockstep', () => {
    const samples = new Set(Array.from({ length: 30 }, () => backoffMs(5)));
    expect(samples.size).toBeGreaterThan(1);
  });

  it('never returns less than half the exponential value', () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const exponential = Math.min(300_000, 1000 * 2 ** attempt);
      expect(backoffMs(attempt)).toBeGreaterThanOrEqual(exponential / 2);
    }
  });
});

describe('ApiError', () => {
  it('marks server errors and throttling as retryable, client errors as not', () => {
    expect(new ApiError('x', 500, true).retryable).toBe(true);
    expect(new ApiError('x', 401, false).retryable).toBe(false);
  });
});

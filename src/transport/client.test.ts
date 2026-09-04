import { describe, expect, it } from 'vitest';
import { ApiError, BatchResult, backoffMs, retryAfterMs } from './client.js';

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

describe('retryAfterMs', () => {
  it('reads delta-seconds and HTTP dates, ignores garbage', () => {
    expect(retryAfterMs('30')).toBe(30_000);
    expect(retryAfterMs(new Date(Date.now() + 60_000).toUTCString())).toBeGreaterThan(50_000);
    expect(retryAfterMs('soon')).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
  });
});

describe('BatchResult', () => {
  it('accepts the server shape with and without a quota block, rejects an error page', () => {
    expect(BatchResult.safeParse({ accepted: 1, duplicates: 0, rejected: [] }).success).toBe(true);
    expect(
      BatchResult.safeParse({ accepted: 0, duplicates: 0, rejected: [], quota: { limit: null, used: null, exceeded: false } }).success,
    ).toBe(true);
    expect(BatchResult.safeParse({ error: 'Bad Gateway' }).success).toBe(false);
  });
});

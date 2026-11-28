import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError, BatchResult, backoffMs, errorCode, parseServerConfig, retryAfterMs } from './client.js';
import { compileRules } from '../privacy/redact.js';

describe('parseServerConfig', () => {
  it('drops only the malformed redaction rules, keeping the config and the valid ones', () => {
    const config = parseServerConfig({
      privacy_mode: 'analytics',
      redaction_rules: [{ pattern: 'acme-\\d+', replacement: '[org]' }, { pattern: 1 }, null, 'x', { replacement: 'y' }],
    });
    expect(config?.privacy_mode).toBe('analytics');
    expect(config?.redaction_rules).toEqual([{ pattern: 'acme-\\d+', replacement: '[org]' }, null, null, null, null]);
    expect(parseServerConfig({ privacy_mode: 'analytics' })?.redaction_rules).toEqual([]);
  });

  it("numbers skipped rules by their index in the server's array, malformed ones included", () => {
    const config = parseServerConfig({
      privacy_mode: 'analytics',
      redaction_rules: [{ pattern: 1 }, { pattern: '(a+)+', replacement: 'x' }, { pattern: 'ok', replacement: 'y' }],
    });
    const skipped: string[] = [];
    expect(compileRules(config!.redaction_rules, (m) => skipped.push(m)).map((r) => r.name)).toEqual(['org_rule_2']);
    expect(skipped).toEqual(['org redaction rule #0 skipped: malformed', expect.stringMatching(/^org redaction rule #1 skipped: /)]);
  });

  it('keeps unknown fields, defaults missing rules to [], leaves event_types undefined', () => {
    const config = parseServerConfig({ privacy_mode: 'analytics', retention_days: 30, future_field: 1 });
    expect(config).toMatchObject({ privacy_mode: 'analytics', redaction_rules: [], future_field: 1 });
    expect(config?.event_types).toBeUndefined();
  });

  it('reads an unknown or missing org mode as metadata, never looser', () => {
    expect(parseServerConfig({ privacy_mode: 'everything' })?.privacy_mode).toBe('metadata');
    expect(parseServerConfig({})?.privacy_mode).toBe('metadata');
  });

  it('rejects a non-array rule list and non-objects', () => {
    expect(parseServerConfig({ privacy_mode: 'full', redaction_rules: 'acme' })).toBeNull();
    expect(parseServerConfig('<html>Bad Gateway</html>')).toBeNull();
    expect(parseServerConfig(null)).toBeNull();
  });
});

describe('errorCode — failure bodies are never logged raw', () => {
  it('keeps only a redacted, capped server error code', () => {
    expect(errorCode('{"error":"invalid_api_key"}')).toBe('invalid_api_key');
    expect(errorCode('{"error":{"code":"quota_exceeded","detail":"…"}}')).toBe('quota_exceeded');
    expect(errorCode(`{"error":"bad key ghp_${'a'.repeat(36)}"}`)).not.toContain('ghp_');
    expect(errorCode(`{"error":"${'z'.repeat(500)}"}`)).toHaveLength(120);
    expect(errorCode('<html>echoing your prompt</html>')).toBe('');
    expect(errorCode('{"message":"echo of the event"}')).toBe('');
  });

  it('puts status and code in the ApiError message, not the body', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'bad_event', echoed: 'SECRET-PROMPT' }), { status: 400 })) as typeof fetch;
    try {
      const err = await new ApiClient({ apiUrl: 'https://api.example', apiKey: 'k' }).getConfig().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toBe('GET /v1/collector/config failed: 400 bad_event');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

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

describe('ApiClient.summary', () => {
  it('asks for the key owner summary with the key as a bearer token', async () => {
    const { ApiClient } = await import('./client.js');
    const calls: { url: string; auth: string | null }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get('authorization') });
      return new Response(JSON.stringify({ totals: { sessions: 2 } }), { status: 200 });
    }) as typeof fetch;
    try {
      const out = await new ApiClient({ apiUrl: 'https://api.example/', apiKey: 'at_test_k' }).summary(7.9);
      expect(out).toEqual({ totals: { sessions: 2 } });
      expect(calls).toEqual([{ url: 'https://api.example/v1/collector/summary?days=7', auth: 'Bearer at_test_k' }]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

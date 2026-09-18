import { describe, expect, it } from 'vitest';
import { Config, DEFAULT_API_URL } from './config.js';

/**
 * `login` used to carry the previous `api_url` forward. A production key then
 * went to whatever host was configured last and came back 401 "Invalid API
 * key" — accurate about the response, wrong about the cause, and the key is
 * the one thing a reader will go and re-check.
 *
 * These assert the resolution rule itself, which is the part that was wrong:
 * explicit flag wins, otherwise production, never the stale value.
 */
function resolveLoginUrl(apiUrlFlag: string | undefined, existing: { api_url?: string }): string {
  return Config.parse({
    ...existing,
    api_url: apiUrlFlag ?? DEFAULT_API_URL,
    api_key: 'at_live_whatever',
  }).api_url;
}

describe('login endpoint resolution', () => {
  it('defaults to production even when a different host is already configured', () => {
    const existing = { api_url: 'https://agentstrack.21370402.xyz/' };
    expect(resolveLoginUrl(undefined, existing)).toBe(DEFAULT_API_URL);
  });

  it('honours an explicit --api-url, so self-hosting still works', () => {
    const existing = { api_url: 'https://agentstrack.21370402.xyz/' };
    expect(resolveLoginUrl('https://helix.example.com', existing)).toBe('https://helix.example.com');
  });

  it('defaults to production on a fresh install too', () => {
    expect(resolveLoginUrl(undefined, {})).toBe(DEFAULT_API_URL);
  });

  it('points at the collector host, not the dashboard apex', () => {
    // The dashboard serves /v1 on the apex to keep its session cookie
    // same-origin; a collector has no cookie and uses api. — mixing them up
    // is a working request against the wrong vhost, which is hard to spot.
    expect(DEFAULT_API_URL).toBe('https://api.agentstrack.ai');
  });

  it('still rejects a plaintext endpoint, flag or not', () => {
    expect(() => resolveLoginUrl('http://collector.example.com', {})).toThrow();
  });
});

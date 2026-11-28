import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Collector, ORG_POLICY_META, UPLOAD_PAUSE_META } from '../daemon.js';
import { Config } from '../config.js';
import { Spool } from './spool.js';
import { ApiError, type BatchResult } from '../transport/client.js';
import { SCHEMA_VERSION, type EventEnvelope } from '../schema.js';
import type { PollContext } from '../adapters/types.js';

/**
 * The upload policy runs once per WAVE on the collected outcomes, not once per
 * concurrent batch. Each case here was a live bug when the policy ran inside
 * sendBatch: siblings undid a 413 halving, backoff escalated concurrency× per
 * wave, and a revoked key counted strikes against telemetry until it was
 * deleted.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const event = (): EventEnvelope => ({
  event_id: randomUUID(),
  schema_version: SCHEMA_VERSION,
  occurred_at: new Date().toISOString(),
  collector_id: '00000000-0000-4000-8000-000000000000',
  session_id: 's1',
  agent: 'claude_code',
  event_type: 'heartbeat',
  payload: {},
});

const ok = (n: number): BatchResult => ({ accepted: n, duplicates: 0, rejected: [] });

/** A collector over a temp spool holding `events` events, with a scripted sendBatch. */
function setup(events: number, batchSize: number, respond: (call: number, batch: EventEnvelope[]) => Promise<BatchResult>) {
  const dir = mkdtempSync(join(tmpdir(), 'agentstrack-flush-'));
  dirs.push(dir);
  const spool = new Spool(join(dir, 'spool.db'));
  spool.enqueue(Array.from({ length: events }, event));
  // A known org policy: without one a registered collector holds its uploads.
  spool.setMeta(ORG_POLICY_META, JSON.stringify({ privacy_mode: 'full', redaction_rules: [] }));
  let calls = 0;
  const client = {
    sendBatch: vi.fn((batch: EventEnvelope[]) => respond(calls++, batch)),
    registerCollector: vi.fn(),
    getConfig: vi.fn(),
    health: vi.fn(),
  };
  const config = Config.parse({
    api_key: 'at_test',
    collector_id: '00000000-0000-4000-8000-000000000000',
    tracking: { git_metadata: false, agents: [] },
    upload: { batch_size: batchSize, concurrency: 4 },
  });
  return { spool, client, collector: new Collector(config, { spool, client }) };
}

describe('Collector.flush', () => {
  it('acks the batches that succeeded, keeps the one that failed, backs off once', async () => {
    const { spool, collector } = setup(4, 1, async (call) => {
      if (call === 1) throw new ApiError('boom', 500, true);
      return ok(1);
    });
    await collector.flush();
    expect(spool.depth()).toBe(1);
    const state = collector.uploadState();
    expect(state.failures).toBe(1);
    expect(state.nextUploadAt).toBeGreaterThan(Date.now());
  });

  it('halves the batch size exactly once per wave with a 413, whatever the siblings did', async () => {
    const { spool, collector } = setup(8, 4, async (call, batch) => {
      if (call === 0) throw new ApiError('too big', 413, false);
      return ok(batch.length);
    });
    await collector.flush();
    expect(collector.uploadState().batchSize).toBe(2);
    expect(spool.depth()).toBe(4); // the 413 batch stays, the sibling was acked
  });

  it('halves from the batch that failed, not from the configured size', async () => {
    // 10 events at batch size 8, concurrency 4: one wave of 8 + 2. The 2 fails.
    const { collector } = setup(10, 8, async (_call, batch) => {
      if (batch.length === 2) throw new ApiError('invalid', 422, false);
      return ok(batch.length);
    });
    await collector.flush(1);
    expect(collector.uploadState().batchSize).toBe(1);
  });

  it('holds uploads while a registered collector has no org policy', async () => {
    const { spool, client, collector } = setup(2, 2, async (_call, batch) => ok(batch.length));
    spool.deleteMeta(ORG_POLICY_META);
    const fresh = new Collector(
      Config.parse({ api_key: 'at_test', collector_id: '00000000-0000-4000-8000-000000000000', tracking: { git_metadata: false, agents: [] } }),
      { spool, client },
    );
    expect(await fresh.flush()).toBe(false);
    expect(client.sendBatch).not.toHaveBeenCalled();
    expect(spool.depth()).toBe(2);
    collector.stop();
  });

  it('counts one failure per wave, not one per batch', async () => {
    const { collector } = setup(4, 1, async () => {
      throw new ApiError('down', 503, true);
    });
    await collector.flush();
    expect(collector.uploadState().failures).toBe(1);
    await collector.flush();
    expect(collector.uploadState().failures).toBe(2);
  });

  it('honours Retry-After as the minimum backoff', async () => {
    const { collector } = setup(1, 1, async () => {
      throw new ApiError('slow down', 429, true, 120_000);
    });
    const before = Date.now();
    await collector.flush();
    expect(collector.uploadState().nextUploadAt).toBeGreaterThanOrEqual(before + 120_000);
  });

  it('pauses on 401 without acking or striking anything', async () => {
    const { spool, collector } = setup(4, 1, async () => {
      throw new ApiError('revoked', 401, false);
    });
    const fail = vi.spyOn(spool, 'fail');
    await collector.flush();
    expect(spool.depth()).toBe(4);
    expect(fail).not.toHaveBeenCalled();
    expect(collector.uploadState().paused).toBe('auth');
    expect(spool.getMeta(UPLOAD_PAUSE_META)).toMatch(/^auth: /);
  });

  it('pauses on an over-quota 200 instead of acking rejected events', async () => {
    const { spool, collector } = setup(2, 2, async (_call, batch) => ({
      accepted: 0,
      duplicates: 0,
      rejected: batch.map((_, index) => ({ index, reason: 'monthly event quota exceeded for this plan' })),
      quota: { limit: 1000, used: 1000, exceeded: true },
    }));
    await collector.flush();
    expect(spool.depth()).toBe(2);
    expect(collector.uploadState().paused).toBe('quota');
  });

  it('strikes a single rejected event instead of pausing the queue as a schema mismatch', async () => {
    const { spool, collector } = setup(1, 1, async () => ({
      accepted: 0,
      duplicates: 0,
      rejected: [{ index: 0, reason: 'occurred_at is in the future' }],
    }));
    await collector.flush();
    expect(collector.uploadState().paused).toBeNull();
    expect(spool.depth()).toBe(1);
    for (let i = 0; i < 8; i++) await collector.flush();
    expect(spool.depth()).toBe(0);
  });

  it('drops a non-retryable batch only after max_retries strikes', async () => {
    const { spool, collector } = setup(1, 1, async () => {
      throw new ApiError('bad request', 400, false);
    });
    for (let i = 0; i < 8; i++) await collector.flush();
    expect(spool.depth()).toBe(0);
  });

  it('resets the counter and clears the pause once a whole wave succeeds', async () => {
    let fail = true;
    const { spool, collector } = setup(2, 1, async (_call, batch) => {
      if (fail) throw new ApiError('revoked', 401, false);
      return ok(batch.length);
    });
    await collector.flush();
    fail = false;
    await collector.flush();
    expect(spool.depth()).toBe(0);
    expect(collector.uploadState()).toMatchObject({ failures: 0, paused: null });
    expect(spool.getMeta(UPLOAD_PAUSE_META)).toBeNull();
  });
});

describe('poll', () => {
  it('does not persist a cursor or started-marker when the enqueue throws', async () => {
    const { spool, collector } = setup(0, 1, async () => ok(0));
    const poll = async (ctx: PollContext) => {
      if (ctx.getMeta('opencode:started:ses_a') !== null) return [];
      ctx.setMeta('opencode:started:ses_a', '1');
      return [{ event: { ...event(), event_type: 'session.started' as const, payload: { external_session_id: 'ses_a' } } }];
    };
    const enqueue = vi.spyOn(spool, 'enqueue').mockImplementationOnce(() => {
      throw new Error('SQLITE_FULL');
    });
    // @ts-expect-error private
    await expect(collector.pollAdapter(poll, 'c1', undefined)).rejects.toThrow('SQLITE_FULL');
    expect(spool.getMeta('opencode:started:ses_a')).toBeNull();
    enqueue.mockRestore();
    // @ts-expect-error private
    expect(await collector.pollAdapter(poll, 'c1', undefined)).toEqual({ queued: 1, dropped: 0 });
    expect(spool.getMeta('opencode:started:ses_a')).toBe('1');
  });

  it('drops a polled event with no known project while excluded_projects is set, and counts it', async () => {
    const { spool, collector } = setup(0, 1, async () => ok(0));
    // @ts-expect-error private
    collector.config = { ...collector.config, privacy: { ...collector.config.privacy, excluded_projects: ['/w/secret'] } };
    const poll = async () => [
      { event: { ...event(), event_type: 'session.started' as const, payload: {} } },
      { event: { ...event(), event_type: 'session.started' as const, payload: {} }, cwd: '/w/public' },
    ];
    // @ts-expect-error private
    expect(await collector.pollAdapter(poll, 'c1', undefined)).toEqual({ queued: 1, dropped: 1 });
    expect(spool.depth()).toBe(1);
  });
});

describe('idle session.ended', () => {
  it('ends a quiet session once, at the moment the timeout elapsed, with a stable id', () => {
    const { spool, collector } = setup(0, 1, async () => ok(0));
    const quiet = { ...event(), occurred_at: new Date(Date.now() - 600_000).toISOString() };
    // Private hooks: the public path needs real transcripts under the agent's home.
    // @ts-expect-error private
    collector.trackSession(quiet);
    // @ts-expect-error private
    expect(collector.endIdleSessions(120_000, 'timeout')).toBe(1);
    // @ts-expect-error private
    expect(collector.endIdleSessions(120_000, 'timeout')).toBe(0);

    const ended = spool.peek(10).map((p) => p.event);
    expect(ended).toHaveLength(1);
    expect(ended[0]!.event_type).toBe('session.ended');
    expect(ended[0]!.payload).toEqual({ external_session_id: 's1', reason: 'timeout' });
    expect(Date.parse(ended[0]!.occurred_at)).toBe(Date.parse(quiet.occurred_at) + 120_000);
    expect(ended[0]!.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('event types the server has not announced', () => {
  it('drops rate_limit.reported until the server lists it in event_types', () => {
    const { spool, collector } = setup(0, 1, async () => ok(0));
    const item = () => ({
      event: {
        ...event(),
        event_type: 'rate_limit.reported' as const,
        payload: { source: 'codex', windows: [{ window_minutes: 300, used_percent: 5 }] },
      },
      eventId: randomUUID(),
    });
    // @ts-expect-error private — an older server: no event_types at all
    collector.serverConfig = { privacy_mode: 'analytics', redaction_rules: [] };
    // @ts-expect-error private
    expect(collector.enqueue([item()], 'c1')).toBe(0);
    // @ts-expect-error private
    collector.serverConfig = { privacy_mode: 'analytics', redaction_rules: [], event_types: ['rate_limit.reported'] };
    // @ts-expect-error private
    expect(collector.enqueue([item()], 'c1')).toBe(1);
    expect(spool.depth()).toBe(1);
  });
});

describe('Open Island plan windows', () => {
  it('attach to the newest Claude session once per file change and never count as activity', () => {
    const { spool, collector } = setup(0, 1, async () => ok(0));
    const dir = mkdtempSync(join(tmpdir(), 'agentstrack-oi-'));
    dirs.push(dir);
    const path = join(dir, 'rl.json');
    writeFileSync(path, '{"five_hour":{"used_percentage":29}}');
    // @ts-expect-error private
    collector.serverConfig = { privacy_mode: 'analytics', redaction_rules: [], event_types: ['rate_limit.reported'] };
    // @ts-expect-error private
    collector.openSessions.set('claude_code::old', { agent: 'claude_code', sessionId: 'old', lastAtMs: 1 });
    // @ts-expect-error private
    collector.openSessions.set('claude_code::new', { agent: 'claude_code', sessionId: 'new', lastAtMs: 2 });
    // @ts-expect-error private
    collector.openSessions.set('codex::x', { agent: 'codex', sessionId: 'x', lastAtMs: 3 });

    // @ts-expect-error private
    expect(collector.reportOpenIslandRateLimits(path)).toBe(1);
    // @ts-expect-error private
    expect(collector.reportOpenIslandRateLimits(path)).toBe(0); // unchanged file
    const [sent] = spool.peek(10);
    expect(sent!.event).toMatchObject({ session_id: 'new', event_type: 'rate_limit.reported', payload: { source: 'open_island' } });
    // @ts-expect-error private — the reading did not move the session's last activity
    expect(collector.openSessions.get('claude_code::new').lastAtMs).toBe(2);
  });
});
